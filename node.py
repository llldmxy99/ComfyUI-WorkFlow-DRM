import gc
import uuid
from typing import Any

from aiohttp import web
from server import PromptServer

def _load_drm_core_impl():
    drm_core_py = None
    drm_core_bin = None
    py_error = None
    bin_error = None
    try:
        from . import drm_core as _drm_core_py

        drm_core_py = _drm_core_py
    except Exception as e:
        py_error = e
    try:
        from . import drm_core_ext as _drm_core_bin

        drm_core_bin = _drm_core_bin
    except Exception as e:
        bin_error = e
    if drm_core_py is not None and drm_core_bin is not None:
        if getattr(drm_core_bin, "CORE_API_VERSION", 0) > getattr(drm_core_py, "CORE_API_VERSION", 0):
            return drm_core_bin
        return drm_core_py
    if drm_core_bin is not None:
        return drm_core_bin
    if drm_core_py is not None:
        return drm_core_py
    raise ImportError(
        f"无法加载 DRM 核心模块，drm_core_ext 错误: {bin_error}; drm_core 错误: {py_error}"
    )


drm_core_impl = _load_drm_core_impl()

MAX_EXPOSED_IO = drm_core_impl.MAX_EXPOSED_IO
BlackBoxRuntime = drm_core_impl.BlackBoxRuntime
decrypt_subgraph_json = drm_core_impl.decrypt_subgraph_json
encrypt_subgraph_json = drm_core_impl.encrypt_subgraph_json
get_machine_code = drm_core_impl.get_machine_code

MIN_REQUIRED_EXPOSED_IO = 32
if MAX_EXPOSED_IO < MIN_REQUIRED_EXPOSED_IO:
    MAX_EXPOSED_IO = MIN_REQUIRED_EXPOSED_IO


class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False


ANY = AnyType("*")


@PromptServer.instance.routes.post("/drm/encrypt")
async def drm_encrypt(request):
    try:
        data = await request.json()
        plaintext = str(data.get("plaintext", ""))
        password = str(data.get("password", ""))
        encrypted = encrypt_subgraph_json(plaintext, password)
        return web.json_response({"ok": True, "encrypted_payload": encrypted})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=400)


@PromptServer.instance.routes.post("/drm/decrypt")
async def drm_decrypt(request):
    try:
        data = await request.json()
        encrypted_payload = data.get("encrypted_payload", {})
        password = str(data.get("password", ""))
        if not isinstance(encrypted_payload, dict):
            raise ValueError("encrypted_payload 格式错误")
        plaintext = decrypt_subgraph_json(encrypted_payload, password, "")
        return web.json_response({"ok": True, "plaintext": plaintext})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=400)


@PromptServer.instance.routes.get("/drm/machine_code")
async def drm_machine_code(request):
    try:
        return web.json_response({"ok": True, "machine_code": get_machine_code()})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=400)


class DRM_BlackBox_Node:
    CATEGORY = "DRM/BlackBox"
    FUNCTION = "execute"
    RETURN_TYPES = tuple([ANY for _ in range(MAX_EXPOSED_IO)])
    RETURN_NAMES = tuple([f"out_{i}" for i in range(MAX_EXPOSED_IO)])

    @classmethod
    def INPUT_TYPES(cls):
        optional = {}
        for i in range(MAX_EXPOSED_IO):
            optional[f"in_{i}"] = (ANY, {"default": None})
        return {
            "required": {
                "subgraph_json": ("STRING", {"multiline": True, "default": ""}),
                "password": ("STRING", {"multiline": False, "default": ""}),
                "license_code": ("STRING", {"multiline": True, "default": ""}),
                "run_mode": (["native_expand", "legacy_interpreter"], {"default": "native_expand"}),
            },
            "optional": optional,
            "hidden": {
                "prompt": "PROMPT",
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    def execute(
        self,
        subgraph_json: str,
        password: str,
        license_code: str,
        run_mode: str,
        prompt=None,
        unique_id=None,
        extra_pnginfo=None,
        **kwargs,
    ):
        payload = BlackBoxRuntime.materialize_payload(subgraph_json, password, license_code)
        if str(run_mode) == "legacy_interpreter":
            outputs = BlackBoxRuntime.execute_subprompt(
                payload,
                kwargs,
                MAX_EXPOSED_IO,
                {
                    "prompt": prompt,
                    "unique_id": unique_id,
                    "extra_pnginfo": extra_pnginfo,
                },
            )
        else:
            outputs = BlackBoxRuntime.build_expand_plan(
                payload,
                kwargs,
                MAX_EXPOSED_IO,
                str(unique_id or ""),
            )

        if isinstance(extra_pnginfo, list):
            node_id_value = unique_id if unique_id is not None else str(uuid.uuid4())
            for item in extra_pnginfo:
                if isinstance(item, dict) and "workflow" in item:
                    workflow = item.get("workflow")
                    if isinstance(workflow, dict):
                        workflow["nodes"] = [n for n in workflow.get("nodes", []) if n.get("type") != "DRM_BlackBox_Node"] + [
                            {"id": node_id_value, "type": "DRM_BlackBox_Node", "widgets_values": ["<sealed>"]}
                        ]

        subgraph_json = ""
        payload = {}
        gc.collect()
        return outputs


NODE_CLASS_MAPPINGS = {
    "DRM_BlackBox_Node": DRM_BlackBox_Node,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "DRM_BlackBox_Node": "DRM BlackBox Node",
}
