import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const BLACKBOX_TYPE = "DRM_BlackBox_Node";
const MAX_EXPOSED_IO = 32;

function selectedNodes() {
  const map = app.canvas.selected_nodes || {};
  return Object.values(map);
}

async function encryptPayloadOnServer(payload, password) {
  const resp = await api.fetchApi("/drm/encrypt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      plaintext: JSON.stringify(payload),
      password,
    }),
  });
  const data = await resp.json();
  if (!resp.ok || !data?.ok) {
    throw new Error(data?.error || "加密失败");
  }
  return data.encrypted_payload;
}

async function decryptPayloadOnServer(encryptedPayload, password) {
  const resp = await api.fetchApi("/drm/decrypt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      encrypted_payload: encryptedPayload,
      password,
    }),
  });
  const data = await resp.json();
  if (!resp.ok || !data?.ok) {
    throw new Error(data?.error || "解密失败");
  }
  return JSON.parse(data.plaintext);
}

async function fetchMachineCode() {
  const resp = await api.fetchApi("/drm/machine_code", { method: "GET" });
  const data = await resp.json();
  if (!resp.ok || !data?.ok) {
    throw new Error(data?.error || "获取机器码失败");
  }
  return data.machine_code;
}

function normalizeLink(link) {
  if (!link) return null;
  if (Array.isArray(link)) {
    const [id, origin_id, origin_slot, target_id, target_slot, type] = link;
    return { id, origin_id, origin_slot, target_id, target_slot, type };
  }
  if (typeof link === "object") {
    const { id, origin_id, origin_slot, target_id, target_slot, type } = link;
    if (origin_id == null || target_id == null) return null;
    return { id, origin_id, origin_slot, target_id, target_slot, type };
  }
  return null;
}

function normalizeWorkflowLink(link) {
  if (!link) return null;
  if (Array.isArray(link)) {
    const [id, origin_id, origin_slot, target_id, target_slot, type] = link;
    return { id, origin_id, origin_slot, target_id, target_slot, type };
  }
  if (typeof link === "object") {
    const { id, origin_id, origin_slot, target_id, target_slot, type } = link;
    if (origin_id == null || target_id == null) return null;
    return { id, origin_id, origin_slot, target_id, target_slot, type };
  }
  return null;
}

function normalizeSlotType(slotType) {
  if (Array.isArray(slotType) && slotType.length) {
    return String(slotType[0] || "*");
  }
  if (typeof slotType === "string" && slotType.trim()) {
    return slotType.trim();
  }
  return "*";
}

function buildBoundary(links, workflow, fullPrompt, selectedIdSet) {
  const extInputs = [];
  const extOutputs = [];
  const inMap = new Map();
  const outMap = new Map();
  let inputDropped = 0;
  let outputDropped = 0;
  const workflowNodes = workflow?.nodes || [];
  const workflowLinks = workflow?.links || [];
  const workflowNodeMap = new Map(workflowNodes.map((n) => [String(n.id), n]));
  const workflowLinksById = new Map();

  workflowLinks.forEach((l) => {
    const parsed = normalizeWorkflowLink(l);
    if (!parsed) return;
    workflowLinksById.set(String(parsed.id), parsed);
  });

  const sourceLinks = Array.isArray(workflowLinks) && workflowLinks.length ? workflowLinks : Object.values(links || {});
  for (const rawLink of sourceLinks) {
    const parsed = normalizeWorkflowLink(rawLink) || normalizeLink(rawLink);
    if (!parsed) continue;
    const { id, origin_id, origin_slot, target_id, target_slot, type } = parsed;
    const originIn = selectedIdSet.has(origin_id);
    const targetIn = selectedIdSet.has(target_id);

    if (originIn && !targetIn) {
      const key = `${origin_id}:${origin_slot}->${target_id}:${target_slot}`;
      if (!outMap.has(key)) {
        if (extOutputs.length < MAX_EXPOSED_IO) {
          const outputName = `out_${extOutputs.length}`;
          outMap.set(key, outputName);
          extOutputs.push({
            name: outputName,
            source: [String(origin_id), origin_slot],
            target: [String(target_id), target_slot],
            link_id: id,
            type: normalizeSlotType(type || "*"),
          });
        } else {
          outputDropped += 1;
        }
      }
    }
  }

  for (const [nodeId, nodeData] of Object.entries(fullPrompt || {})) {
    if (!selectedIdSet.has(Number(nodeId))) continue;
    const workflowNode = workflowNodeMap.get(String(nodeId));
    const nodeInputs = Object.entries(nodeData?.inputs || {});
    for (const [inputName, value] of nodeInputs) {
      if (!Array.isArray(value) || value.length !== 2) continue;
      const [srcNodeId, srcSlot] = value;
      if (selectedIdSet.has(Number(srcNodeId))) continue;
      const key = `${nodeId}:${inputName}`;
      if (inMap.has(key)) continue;
      if (extInputs.length >= MAX_EXPOSED_IO) {
        inputDropped += 1;
        continue;
      }
      const linkId = getInputLinkId(workflowNode, inputName);
      const wl = linkId != null ? workflowLinksById.get(String(linkId)) : null;
      const inputNameExposed = `in_${extInputs.length}`;
      const inputTypeRaw = (workflowNode?.inputs || []).find((x) => x?.name === inputName)?.type || "*";
      const inputType = normalizeSlotType(inputTypeRaw);
      inMap.set(key, inputNameExposed);
      extInputs.push({
        name: inputNameExposed,
        source: [String(wl?.origin_id ?? srcNodeId), wl?.origin_slot ?? srcSlot],
        target_node_id: String(nodeId),
        target_input_name: inputName,
        link_id: wl?.id ?? linkId ?? null,
        type: inputType,
        required: true,
      });
    }
  }

  return { extInputs, extOutputs, inputDropped, outputDropped };
}

function getInputSlotIndex(workflowNode, inputName) {
  const inputs = workflowNode?.inputs || [];
  for (let i = 0; i < inputs.length; i++) {
    if (inputs[i]?.name === inputName) return i;
  }
  return -1;
}

function getInputLinkId(workflowNode, inputName) {
  const inputs = workflowNode?.inputs || [];
  for (let i = 0; i < inputs.length; i++) {
    if (inputs[i]?.name === inputName) return inputs[i]?.link ?? null;
  }
  return null;
}

function buildSubPrompt(fullPrompt, workflow, selectedIdSet, extInputs) {
  const subPrompt = {};
  const extInputLookup = new Map();
  for (const item of extInputs) {
    extInputLookup.set(`${item.target_node_id}:${item.target_input_name}`, item.name);
  }

  for (const [nodeId, nodeData] of Object.entries(fullPrompt)) {
    if (!selectedIdSet.has(Number(nodeId))) continue;
    const cloned = structuredClone(nodeData);
    const entries = Object.entries(cloned.inputs || {});
    for (const [inputName, value] of entries) {
      if (Array.isArray(value) && value.length === 2) {
        const [srcNodeId] = value;
        if (!selectedIdSet.has(Number(srcNodeId))) {
          const key = `${nodeId}:${inputName}`;
          const extName = extInputLookup.get(key);
          if (extName) {
            cloned.inputs[inputName] = { $external_input: extName };
          }
        }
      }
    }
    subPrompt[nodeId] = cloned;
  }
  return subPrompt;
}

function collectWorkflowFragment(workflow, selectedIdSet) {
  const nodes = (workflow.nodes || []).filter((n) => selectedIdSet.has(n.id));
  const links = (workflow.links || [])
    .map((l) => normalizeWorkflowLink(l))
    .filter((l) => l && selectedIdSet.has(l.origin_id) && selectedIdSet.has(l.target_id))
    .map((l) => [l.id, l.origin_id, l.origin_slot, l.target_id, l.target_slot, l.type]);
  return { nodes, links };
}

function clearNodeSlots(node) {
  while (node.inputs?.length) node.removeInput(node.inputs.length - 1);
  while (node.outputs?.length) node.removeOutput(node.outputs.length - 1);
}

function nodeHasLinks(node) {
  const inHas = (node.inputs || []).some((i) => i && i.link != null);
  const outHas = (node.outputs || []).some((o) => o && Array.isArray(o.links) && o.links.length > 0);
  return inHas || outHas;
}

function getGraphLinkById(linkId) {
  if (linkId == null) return null;
  const links = app.graph?.links;
  if (!links) return null;
  if (Array.isArray(links)) {
    const found = links.find((x) => {
      const parsed = normalizeWorkflowLink(x) || normalizeLink(x);
      return parsed && String(parsed.id) === String(linkId);
    });
    return normalizeWorkflowLink(found) || normalizeLink(found);
  }
  if (typeof links === "object") {
    const direct = links[linkId] ?? links[String(linkId)];
    const parsedDirect = normalizeWorkflowLink(direct) || normalizeLink(direct);
    if (parsedDirect) return parsedDirect;
    for (const v of Object.values(links)) {
      const parsed = normalizeWorkflowLink(v) || normalizeLink(v);
      if (parsed && String(parsed.id) === String(linkId)) return parsed;
    }
  }
  return null;
}

function findSlotIndexByName(slots, name) {
  for (let i = 0; i < (slots || []).length; i++) {
    if (slots[i]?.name === name) return i;
  }
  return -1;
}

function applyBlackBoxInterfaces(node, exposedInputs, exposedOutputs) {
  const targetInputs = exposedInputs || [];
  const targetOutputs = exposedOutputs || [];
  const hasLinks = nodeHasLinks(node);
  const oldInputs = (node.inputs || [])
    .map((s, i) => {
      if (!s || s.link == null) return null;
      const parsed = getGraphLinkById(s.link);
      if (!parsed) return null;
      return { idx: i, name: s.name, origin_id: parsed.origin_id, origin_slot: parsed.origin_slot };
    })
    .filter(Boolean);
  const oldOutputs = [];
  (node.outputs || []).forEach((s, i) => {
    if (!s || !Array.isArray(s.links) || !s.links.length) return;
    const saved = s.links
      .map((linkId) => getGraphLinkById(linkId))
      .filter((p) => p && p.target_id != null && p.target_slot != null)
      .map((p) => ({ target_id: p.target_id, target_slot: p.target_slot }));
    if (saved.length) {
      oldOutputs.push({ idx: i, name: s.name, targets: saved });
    }
  });
  const sameInputs =
    (node.inputs || []).length === targetInputs.length &&
    targetInputs.every((item, i) => {
      const cur = (node.inputs || [])[i];
      return cur && cur.name === item.name;
    });
  const sameOutputs =
    (node.outputs || []).length === targetOutputs.length &&
    targetOutputs.every((item, i) => {
      const cur = (node.outputs || [])[i];
      return cur && cur.name === item.name;
    });
  if (sameInputs && sameOutputs) {
    return;
  }
  clearNodeSlots(node);
  targetInputs.forEach((item) => node.addInput(item.name, normalizeSlotType(item.type || "*")));
  targetOutputs.forEach((item) => node.addOutput(item.name, normalizeSlotType(item.type || "*")));
  if (!hasLinks) {
    return;
  }

  oldInputs.forEach((oldSlot) => {
    const newIdxByName = findSlotIndexByName(node.inputs || [], oldSlot.name);
    const newIdx = newIdxByName >= 0 ? newIdxByName : oldSlot.idx < (node.inputs || []).length ? oldSlot.idx : -1;
    if (newIdx < 0) return;
    const originNode = app.graph.getNodeById(Number(oldSlot.origin_id));
    if (!originNode) return;
    originNode.connect(oldSlot.origin_slot, node, newIdx);
  });

  oldOutputs.forEach((oldSlot) => {
    const newIdxByName = findSlotIndexByName(node.outputs || [], oldSlot.name);
    const newIdx = newIdxByName >= 0 ? newIdxByName : oldSlot.idx < (node.outputs || []).length ? oldSlot.idx : -1;
    if (newIdx < 0) return;
    (oldSlot.targets || []).forEach((t) => {
      const targetNode = app.graph.getNodeById(Number(t.target_id));
      if (!targetNode) return;
      node.connect(newIdx, targetNode, t.target_slot);
    });
  });
}

function extractInterfacesFromPayload(rawPayload) {
  if (!rawPayload || typeof rawPayload !== "object") {
    return { exposedInputs: [], exposedOutputs: [] };
  }
  const schema = rawPayload.interface_schema || null;
  if (schema && typeof schema === "object") {
    return {
      exposedInputs: Array.isArray(schema.exposed_inputs) ? schema.exposed_inputs : [],
      exposedOutputs: Array.isArray(schema.exposed_outputs) ? schema.exposed_outputs : [],
    };
  }
  return {
    exposedInputs: Array.isArray(rawPayload.exposed_inputs) ? rawPayload.exposed_inputs : [],
    exposedOutputs: Array.isArray(rawPayload.exposed_outputs) ? rawPayload.exposed_outputs : [],
  };
}

function syncNodeInterfacesFromWidget(node) {
  const jsonWidget = (node.widgets || []).find((w) => w.name === "subgraph_json");
  if (!jsonWidget?.value) return;
  try {
    const rawPayload = JSON.parse(jsonWidget.value);
    const { exposedInputs, exposedOutputs } = extractInterfacesFromPayload(rawPayload);
    applyBlackBoxInterfaces(node, exposedInputs, exposedOutputs);
  } catch (_e) {}
}

function reconnectBoundary(blackboxNode, extInputs, extOutputs) {
  extInputs.forEach((item, index) => {
    const [originId, originSlot] = item.source;
    const originNode = app.graph.getNodeById(Number(originId));
    if (originNode) {
      originNode.connect(originSlot, blackboxNode, index);
    }
  });

  extOutputs.forEach((item, index) => {
    const [targetId, targetSlot] = item.target;
    const targetNode = app.graph.getNodeById(Number(targetId));
    if (targetNode) {
      blackboxNode.connect(index, targetNode, targetSlot);
    }
  });
}

function instantiateFragmentNodes(fragmentNodes) {
  const oldToNew = new Map();
  fragmentNodes.forEach((item) => {
    const node = LiteGraph.createNode(item.type);
    if (!node) {
      throw new Error(`无法创建节点类型: ${item.type}`);
    }
    app.graph.add(node);
    const cfg = structuredClone(item);
    delete cfg.id;
    node.configure(cfg);
    oldToNew.set(String(item.id), node.id);
  });
  return oldToNew;
}

function reconnectFragmentInternalLinks(fragmentLinks, idMap) {
  fragmentLinks.forEach((link) => {
    const parsed = normalizeLink(link);
    if (!parsed) return;
    const sourceNode = app.graph.getNodeById(idMap.get(String(parsed.origin_id)));
    const targetNode = app.graph.getNodeById(idMap.get(String(parsed.target_id)));
    if (sourceNode && targetNode) {
      sourceNode.connect(parsed.origin_slot, targetNode, parsed.target_slot);
    }
  });
}

function reconnectExternalAfterRestore(extInputs, extOutputs, idMap) {
  extInputs.forEach((item) => {
    const sourceNode = app.graph.getNodeById(Number(item.source[0]));
    const targetNode = app.graph.getNodeById(idMap.get(String(item.target_node_id)));
    if (sourceNode && targetNode) {
      const targetSlot = getInputSlotIndex(targetNode, item.target_input_name);
      if (targetSlot >= 0) {
        sourceNode.connect(item.source[1], targetNode, targetSlot);
      }
    }
  });
  extOutputs.forEach((item) => {
    const sourceNode = app.graph.getNodeById(idMap.get(String(item.source[0])));
    const targetNode = app.graph.getNodeById(Number(item.target[0]));
    if (sourceNode && targetNode) {
      sourceNode.connect(item.source[1], targetNode, item.target[1]);
    }
  });
}

function buildBoundaryPreviewText(extInputs, extOutputs, inputDropped, outputDropped) {
  const inPreview = extInputs
    .slice(0, 8)
    .map((x, i) => `${i}. ${x.name} [${normalizeSlotType(x.type || "*")}] -> ${x.target_node_id}.${x.target_input_name}`)
    .join("\n");
  const outPreview = extOutputs
    .slice(0, 8)
    .map((x, i) => `${i}. ${x.name} [${normalizeSlotType(x.type || "*")}] <- ${x.source[0]}:${x.source[1]}`)
    .join("\n");
  const lines = [
    `黑盒边界预览`,
    `输入接口: ${extInputs.length}${inputDropped > 0 ? `（超限丢弃 ${inputDropped}）` : ""}`,
    `输出接口: ${extOutputs.length}${outputDropped > 0 ? `（超限丢弃 ${outputDropped}）` : ""}`,
  ];
  if (inPreview) {
    lines.push("", "输入明细(最多8项):", inPreview);
  }
  if (outPreview) {
    lines.push("", "输出明细(最多8项):", outPreview);
  }
  if (!inPreview && !outPreview) {
    lines.push("", "未检测到边界连线，黑盒将成为独立节点");
  }
  return lines.join("\n");
}

async function previewSelectedBoundary() {
  const nodes = selectedNodes();
  if (!nodes.length) {
    app.ui.dialog.show("请先框选至少一个节点");
    return;
  }
  const selectedIdSet = new Set(nodes.map((n) => n.id));
  const promptData = await app.graphToPrompt();
  const fullPrompt = promptData.output || {};
  const workflow = promptData.workflow || {};
  const { extInputs, extOutputs, inputDropped, outputDropped } = buildBoundary(
    app.graph.links || {},
    workflow,
    fullPrompt,
    selectedIdSet
  );
  app.ui.dialog.show(buildBoundaryPreviewText(extInputs, extOutputs, inputDropped, outputDropped));
}

async function restoreBlackBoxNode(node) {
  const jsonWidget = (node.widgets || []).find((w) => w.name === "subgraph_json");
  if (!jsonWidget?.value) {
    throw new Error("黑盒节点缺少 subgraph_json");
  }
  let payload = JSON.parse(jsonWidget.value);
  if (payload?.encrypted === true) {
    const password = window.prompt("请输入 Password 以还原黑盒节点");
    if (!password) {
      throw new Error("已取消还原");
    }
    payload = await decryptPayloadOnServer(payload, password);
  }
  const fragment = payload.workflow_fragment || { nodes: [], links: [] };
  if (!Array.isArray(fragment.nodes) || !fragment.nodes.length) {
    throw new Error("黑盒内没有可还原节点");
  }
  const oldToNew = instantiateFragmentNodes(fragment.nodes);
  reconnectFragmentInternalLinks(fragment.links || [], oldToNew);
  reconnectExternalAfterRestore(payload.exposed_inputs || [], payload.exposed_outputs || [], oldToNew);
  app.graph.remove(node);
  app.graph.setDirtyCanvas(true, true);
}

async function packSelectedAsBlackBox() {
  const nodes = selectedNodes();
  if (!nodes.length) {
    app.ui.dialog.show("请先框选至少一个节点");
    return;
  }

  const selectedIdSet = new Set(nodes.map((n) => n.id));
  const promptData = await app.graphToPrompt();
  const fullPrompt = promptData.output || {};
  const workflow = promptData.workflow || {};
  const { extInputs, extOutputs, inputDropped, outputDropped } = buildBoundary(
    app.graph.links || {},
    workflow,
    fullPrompt,
    selectedIdSet
  );
  const previewText = buildBoundaryPreviewText(extInputs, extOutputs, inputDropped, outputDropped);
  const confirmed = window.confirm(`${previewText}\n\n确认继续打包？`);
  if (!confirmed) {
    app.ui.dialog.show("已取消打包");
    return;
  }

  const subPrompt = buildSubPrompt(fullPrompt, workflow, selectedIdSet, extInputs);
  const workflowFragment = collectWorkflowFragment(workflow, selectedIdSet);

  const payload = {
    version: 2,
    sub_prompt: subPrompt,
    exposed_inputs: extInputs.map((v) => ({
      name: v.name,
      source: v.source,
      target_node_id: v.target_node_id,
      target_input_name: v.target_input_name,
      type: normalizeSlotType(v.type || "*"),
      required: Boolean(v.required),
    })),
    exposed_outputs: extOutputs.map((v) => ({
      name: v.name,
      source: v.source,
      target: v.target,
      type: normalizeSlotType(v.type || "*"),
    })),
    workflow_fragment: workflowFragment,
  };
  if (!payload.exposed_inputs.length && !payload.exposed_outputs.length) {
    app.ui.dialog.show("未检测到边界连线，黑盒将成为独立节点");
  }
  const password = window.prompt("请输入 Password（用于 AES-GCM 加密）");
  if (!password) {
    app.ui.dialog.show("已取消打包：未输入 Password");
    return;
  }
  const encryptedPayload = await encryptPayloadOnServer(payload, password);
  encryptedPayload.interface_schema = {
    exposed_inputs: payload.exposed_inputs,
    exposed_outputs: payload.exposed_outputs,
  };

  const center = nodes.reduce(
    (acc, n) => {
      acc[0] += n.pos[0];
      acc[1] += n.pos[1];
      return acc;
    },
    [0, 0]
  );
  center[0] /= nodes.length;
  center[1] /= nodes.length;

  nodes.forEach((n) => app.graph.remove(n));

  const blackboxNode = LiteGraph.createNode(BLACKBOX_TYPE);
  blackboxNode.pos = center;
  app.graph.add(blackboxNode);

  applyBlackBoxInterfaces(blackboxNode, payload.exposed_inputs, payload.exposed_outputs);

  blackboxNode.properties = blackboxNode.properties || {};
  blackboxNode.properties.exposed_inputs = payload.exposed_inputs;
  blackboxNode.properties.exposed_outputs = payload.exposed_outputs;

  const jsonWidget = (blackboxNode.widgets || []).find((w) => w.name === "subgraph_json");
  if (jsonWidget) {
    jsonWidget.value = JSON.stringify(encryptedPayload);
  }

  reconnectBoundary(blackboxNode, extInputs, extOutputs);
  app.graph.setDirtyCanvas(true, true);
}

app.registerExtension({
  name: "ComfyUI.WorkFlowDRM.Phase1",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== BLACKBOX_TYPE) return;
    const originalOnConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      if (originalOnConfigure) {
        originalOnConfigure.apply(this, arguments);
      }
      setTimeout(() => syncNodeInterfacesFromWidget(this), 0);
    };
    const originalOnAdded = nodeType.prototype.onAdded;
    nodeType.prototype.onAdded = function (graph) {
      if (originalOnAdded) {
        originalOnAdded.apply(this, arguments);
      }
      if (!(this.inputs?.length || this.outputs?.length)) {
        syncNodeInterfacesFromWidget(this);
      }
    };
    const originalExtra = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
      const opts = originalExtra ? originalExtra.apply(this, arguments) || options : options;
      opts.push({
        content: "输入密码还原黑盒",
        callback: () => {
          restoreBlackBoxNode(this).catch((e) => app.ui.dialog.show(`还原失败: ${String(e)}`));
        },
      });
      opts.push({
        content: "显示本机机器码",
        callback: () => {
          fetchMachineCode()
            .then((code) => window.prompt("复制本机机器码", code))
            .catch((e) => app.ui.dialog.show(`获取机器码失败: ${String(e)}`));
        },
      });
      return opts;
    };
  },
  setup() {
    const original = LGraphCanvas.prototype.getCanvasMenuOptions;
    LGraphCanvas.prototype.getCanvasMenuOptions = function (...args) {
      const options = original ? original.apply(this, args) : [];
      options.push(null);
      options.push({
        content: "打包为黑盒",
        callback: () => {
          packSelectedAsBlackBox().catch((e) => app.ui.dialog.show(`打包失败: ${String(e)}`));
        },
      });
      options.push({
        content: "预览黑盒边界",
        callback: () => {
          previewSelectedBoundary().catch((e) => app.ui.dialog.show(`预览失败: ${String(e)}`));
        },
      });
      return options;
    };
  },
});
