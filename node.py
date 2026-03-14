import gc
from typing import Any

from aiohttp import web
from server import PromptServer

try:
    from .drm_core_ext import (
        MAX_EXPOSED_IO,
        BlackBoxRuntime,
        decrypt_subgraph_json,
        encrypt_subgraph_json,
        get_machine_code,
    )
except Exception:
    from .drm_core import (
        MAX_EXPOSED_IO,
        BlackBoxRuntime,
        decrypt_subgraph_json,
        encrypt_subgraph_json,
        get_machine_code,
    )

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
            },
            "optional": optional,
            "hidden": {
                "prompt": "PROMPT",
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    def execute(self, subgraph_json: str, password: str, license_code: str, prompt=None, unique_id=None, extra_pnginfo=None, **kwargs):
        payload = BlackBoxRuntime.materialize_payload(subgraph_json, password, license_code)
        outputs = BlackBoxRuntime.execute_subprompt(payload, kwargs, MAX_EXPOSED_IO)

        if isinstance(extra_pnginfo, list):
            for item in extra_pnginfo:
                if isinstance(item, dict) and "workflow" in item:
                    workflow = item.get("workflow")
                    if isinstance(workflow, dict):
                        workflow["nodes"] = [n for n in workflow.get("nodes", []) if n.get("type") != "DRM_BlackBox_Node"] + [
                            {"id": unique_id, "type": "DRM_BlackBox_Node", "widgets_values": ["<sealed>"]}
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
