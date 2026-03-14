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

function buildBoundary(links, workflow, fullPrompt, selectedIdSet) {
  const extInputs = [];
  const extOutputs = [];
  const inMap = new Map();
  const outMap = new Map();
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
      if (!outMap.has(key) && extOutputs.length < MAX_EXPOSED_IO) {
        const outputName = `out_${extOutputs.length}`;
        outMap.set(key, outputName);
        extOutputs.push({
          name: outputName,
          source: [String(origin_id), origin_slot],
          target: [String(target_id), target_slot],
          link_id: id,
          type: type || "*",
        });
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
      if (inMap.has(key) || extInputs.length >= MAX_EXPOSED_IO) continue;
      const linkId = getInputLinkId(workflowNode, inputName);
      const wl = linkId != null ? workflowLinksById.get(String(linkId)) : null;
      const inputNameExposed = `in_${extInputs.length}`;
      const inputType = (workflowNode?.inputs || []).find((x) => x?.name === inputName)?.type || "*";
      inMap.set(key, inputNameExposed);
      extInputs.push({
        name: inputNameExposed,
        source: [String(wl?.origin_id ?? srcNodeId), wl?.origin_slot ?? srcSlot],
        target_node_id: String(nodeId),
        target_input_name: inputName,
        link_id: wl?.id ?? linkId ?? null,
        type: inputType || "*",
      });
    }
  }

  return { extInputs, extOutputs };
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
  const { extInputs, extOutputs } = buildBoundary(app.graph.links || {}, workflow, fullPrompt, selectedIdSet);

  const subPrompt = buildSubPrompt(fullPrompt, workflow, selectedIdSet, extInputs);
  const workflowFragment = collectWorkflowFragment(workflow, selectedIdSet);

  const payload = {
    version: 1,
    sub_prompt: subPrompt,
    exposed_inputs: extInputs.map((v) => ({
      name: v.name,
      source: v.source,
      target_node_id: v.target_node_id,
      target_input_name: v.target_input_name,
    })),
    exposed_outputs: extOutputs.map((v) => ({ name: v.name, source: v.source, target: v.target })),
    workflow_fragment: workflowFragment,
  };
  const password = window.prompt("请输入 Password（用于 AES-GCM 加密）");
  if (!password) {
    app.ui.dialog.show("已取消打包：未输入 Password");
    return;
  }
  const encryptedPayload = await encryptPayloadOnServer(payload, password);

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

  clearNodeSlots(blackboxNode);
  extInputs.forEach((item) => blackboxNode.addInput(item.name, item.type || "*"));
  extOutputs.forEach((item) => blackboxNode.addOutput(item.name, item.type || "*"));

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
      return options;
    };
  },
});
