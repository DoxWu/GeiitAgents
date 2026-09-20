"""Opt-in synthetic live provider test. Reads local .env; never prints credentials/errors."""
import asyncio
import json
import logging
import os
import sys
from pathlib import Path

logging.disable(logging.CRITICAL)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


async def main():
    from dotenv import dotenv_values
    from app.schemas.private_model import PrivateCompletion
    from app.services.private_model import complete_private

    config = dotenv_values(Path(__file__).resolve().parents[1] / '.env')
    # Read only these fields. Do not initialize app settings, DB, or fallback providers.
    alternate = os.environ.get('LOCAL_ANSWER_PROVIDER') == 'configured-fallback'
    key = config.get('LLM_FALLBACK_API_KEY' if alternate else 'OPENAI_API_KEY')
    base = config.get('LLM_FALLBACK_API_BASE' if alternate else 'OPENAI_API_BASE')
    model = config.get('LLM_FALLBACK_MODEL_NAME' if alternate else 'LLM_MODEL_NAME')
    payload = json.loads(sys.stdin.read())
    if not key or not base or not model or payload.get('fixture') != 'geiit-local-answer-qa':
        raise ValueError('invalid fixture configuration')
    messages = payload['messages']
    if len(messages) != 2 or len(json.dumps(messages)) > 16000:
        raise ValueError('invalid fixture input')
    result = await complete_private(PrivateCompletion(base_url=base, model=model, messages=messages), key)
    # Only synthetic answer text exits this process; model IDs and provider URLs stay private too.
    print(json.dumps({'content': result['content'], 'model': 'configured-test-model'}, ensure_ascii=True))


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except Exception as exc:
        safe_type = type(exc).__name__
        safe_status = getattr(exc, 'status', None)
        categories = {
            '模型服务拒绝认证，请检查 API Key 和模型权限。': 'authentication',
            '模型服务额度或速率已达上限。': 'rate_limit',
            '模型服务请求失败，请检查接口地址和模型名称。': 'provider_http',
            '模型连接超时或返回格式无效。': 'transport_or_response',
        }
        print(json.dumps({'error': 'Live provider validation failed; no credentials or provider response logged.',
                          'category': categories.get(str(exc), safe_type), 'status': safe_status if isinstance(safe_status, int) else None}))
        sys.exit(1)
