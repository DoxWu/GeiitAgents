"""Explicit synthetic live tool-protocol smoke test; never logs provider data or keys."""
import asyncio
import hashlib
import json
import logging
import sys
from pathlib import Path

logging.disable(logging.CRITICAL)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


async def main():
    if sys.argv[1:] not in (["--run-live"], ["--run-live", "--configured-fallback"]):
        raise ValueError("explicit opt-in required")
    from dotenv import dotenv_values
    from app.schemas.office_tools import PrivateToolCompletion
    from app.services.office_tools import complete_private_tools
    config = dotenv_values(Path(__file__).resolve().parents[1] / ".env")
    fields = ("LLM_FALLBACK_API_KEY", "LLM_FALLBACK_API_BASE", "LLM_FALLBACK_MODEL_NAME") if "--configured-fallback" in sys.argv else ("OPENAI_API_KEY", "OPENAI_API_BASE", "LLM_MODEL_NAME")
    key, base, model = (config.get(name) for name in fields)
    if not all((key, base, model)):
        raise ValueError("configured model missing")
    messages = [
        {"role": "system", "content": "你正在进行合成数据的办公工具验收。通过 create_document 创建一份简短 Markdown 文档，收到成功工具结果后用中文总结。没有 CSV，不用其他工具；不要编造工具结果。"},
        {"role": "user", "content": "创建《合成项目周报》，材料只有：登录页面已完成，安全评审待确认。文档包含进展和待确认两节，总字数少于 150 字。"},
    ]
    seen, names, sizes = set(), [], []
    for round_index in range(4):
        reply = await complete_private_tools(PrivateToolCompletion(base_url=base, model=model, messages=messages), key)
        if not reply["tool_calls"]:
            if not sizes:
                raise ValueError("no document created")
            print(json.dumps({"passed": True, "scope": "synthetic live provider tool protocol; document content checked in memory", "rounds": round_index + 1, "tools": names, "document_characters": sizes}))
            return
        messages.append({"role": "assistant", "content": reply["content"], "tool_calls": reply["tool_calls"]})
        for call in reply["tool_calls"]:
            if call["id"] in seen or len(seen) >= 4 or call["function"]["name"] != "create_document":
                raise ValueError("unexpected tool call")
            seen.add(call["id"])
            args = json.loads(call["function"]["arguments"])
            if set(args) != {"title", "markdown"} or not isinstance(args["markdown"], str) or not 1 <= len(args["markdown"]) <= 50000 or not isinstance(args["title"], str) or not 1 <= len(args["title"]) <= 80:
                raise ValueError("invalid tool arguments")
            if "安全" not in args["markdown"] or "登录" not in args["markdown"]:
                raise ValueError("fixture facts missing")
            sizes.append(len(args["markdown"]))
            names.append(call["function"]["name"])
            messages.append({"role": "tool", "tool_call_id": call["id"], "content": json.dumps({"ok": True, "artifact_id": "synthetic-memory-artifact", "kind": "markdown", "sha256": hashlib.sha256(args["markdown"].encode()).hexdigest()})})
    raise ValueError("round budget exhausted")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as error:
        status = getattr(error, "status", None)
        categories = {"模型工具请求失败，请检查模型权限及工具调用兼容性。": "provider_http", "模型工具响应无效或包含未允许的工具。": "invalid_tool_reply", "模型工具请求超时或返回格式无效。": "transport_or_response"}
        print(json.dumps({"passed": False, "error": "Live tool validation failed; details suppressed", "status": status if isinstance(status, int) else None, "category": categories.get(str(error), type(error).__name__)}))
        sys.exit(1)
