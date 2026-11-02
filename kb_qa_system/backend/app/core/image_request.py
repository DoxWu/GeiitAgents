"""Bounded image inputs and provider adapters. Never discard reference images."""

import base64
import re
from urllib.parse import urlsplit, urlunsplit

from app.core.provider_image import ProviderImageError, image_data_url

IMAGE_EDIT_PATH = '/api/v1/services/aigc/multimodal-generation/generation'


def validate_reference_images(images: list[str]) -> list[str]:
    if not isinstance(images, list) or len(images) > 2:
        raise ValueError('生图最多可发送2张参考图片。')
    for value in images:
        if not isinstance(value, str) or len(value) > 2_000_050:
            raise ValueError('参考图片无效或超限。')
        match = re.fullmatch(r'data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})', value)
        try:
            if not match or len(match[2]) % 4 or image_data_url(match[2]) != value:
                raise ValueError('参考图片内容与类型不匹配。')
        except ProviderImageError:
            raise ValueError('参考图片内容无效或超过1.5 MB。') from None
    return images


def image_target(base_url: str, references: list[str]) -> tuple[str, str, bool]:
    """Return the base, allowed resource and protocol, always on the same origin."""
    if not references:
        return base_url, 'images/generations', False
    parsed = urlsplit(base_url)
    host = parsed.hostname or ''
    dashscope = host in {'dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com'} or bool(
        re.fullmatch(r'[a-z0-9-]+\.(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com', host)
    )
    if dashscope:
        # Keep credentials/query/fragment for the caller's normal URL validator.
        return urlunsplit(parsed._replace(path='')), IMAGE_EDIT_PATH.lstrip('/'), True
    return base_url, 'images/edits', False


def image_request_options(model: str, prompt: str, size: str, references: list[str], dashscope: bool) -> dict:
    if not references:
        return {'json': {'model': model, 'prompt': prompt, 'n': 1, 'size': size, 'response_format': 'b64_json'}}
    if dashscope:
        return {'json': {'model': model, 'input': {'messages': [{'role': 'user', 'content': [
            *({'image': image} for image in references), {'text': prompt},
        ]}]}, 'parameters': {'n': 1, 'size': size.replace('x', '*'), 'prompt_extend': False, 'watermark': False}}}
    files = []
    for index, image in enumerate(references):
        header, encoded = image.split(',', 1)
        mime = header[5:-7]
        extension = 'jpg' if mime == 'image/jpeg' else mime[6:]
        files.append(('image' if len(references) == 1 else 'image[]', (
            f'reference-{index + 1}.{extension}', base64.b64decode(encoded, validate=True), mime,
        )))
    return {'data': {'model': model, 'prompt': prompt, 'n': '1', 'size': size, 'response_format': 'b64_json'}, 'files': files}


def image_result(payload: dict) -> dict:
    data = payload.get('data')
    if isinstance(data, list) and len(data) == 1 and isinstance(data[0], dict):
        return data[0]
    choices = payload.get('output', {}).get('choices', [])
    if len(choices) == 1:
        images = [part['image'] for part in choices[0]['message']['content'] if isinstance(part.get('image'), str)]
        if len(images) == 1:
            return {'url': images[0]}
    raise ValueError('Invalid image response')


def image_error_message(status: int, payload: object, references: bool) -> str:
    # Read fixed error codes only. Provider text may echo credentials and inputs.
    code = payload.get('code') if isinstance(payload, dict) else None
    if isinstance(payload, dict) and isinstance(payload.get('error'), dict):
        code = code or payload['error'].get('code')
    if code == 'AllocationQuota.FreeTierOnly':
        return '参考图编辑调用被百炼的“仅使用免费额度”限制拦截，请检查该模型的可用额度和调用设置。'
    if status in (401, 403):
        return '图像服务拒绝认证，请检查 API Key 和模型权限。'
    if status == 429:
        return '图像服务额度或速率已达上限。'
    if references and status in (400, 404, 405, 415, 422):
        return '参考图生成请求被拒绝，请确认所选模型支持图片编辑及当前接口格式；参考图未被丢弃重试。'
    return '图像服务请求失败，请检查接口地址和生图模型名称。'
