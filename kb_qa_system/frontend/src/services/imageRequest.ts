import type { WorkImage } from '@/types/workbench';
import { validateWorkImage } from './workbenchImages';

export const IMAGE_EDIT_PATH = '/api/v1/services/aigc/multimodal-generation/generation';

export function imageReferenceData(images: WorkImage[] = []): string[] {
  if (!Array.isArray(images) || images.length > 2) throw new Error('生图最多可发送2张参考图片。');
  images.forEach(validateWorkImage);
  return images.map(image => image.dataUrl);
}

export function isDashScopeImageEndpoint(url: URL): boolean {
  return ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com'].includes(url.hostname)
    || /^[a-z0-9-]+\.(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(url.hostname);
}

// Preserve the configured origin: credentials never move to another host.
export function imageRequest(baseUrl: string, model: string, prompt: string, size: string, references: string[]): { url: string; body: BodyInit; json: boolean } {
  if (!references.length) return { url: `${baseUrl}/images/generations`, json: true, body: JSON.stringify({ model, prompt, n: 1, size, response_format: 'b64_json' }) };
  const url = new URL(baseUrl);
  if (isDashScopeImageEndpoint(url)) {
    url.pathname = IMAGE_EDIT_PATH;
    return { url: url.href, json: true, body: JSON.stringify({ model, input: { messages: [{ role: 'user', content: [...references.map(image => ({ image })), { text: prompt }] }] }, parameters: { n: 1, size: size.replace('x', '*'), prompt_extend: false, watermark: false } }) };
  }
  const body = new FormData();
  for (const [key, value] of Object.entries({ model, prompt, n: '1', size, response_format: 'b64_json' })) body.append(key, value);
  references.forEach((dataUrl, index) => {
    const [header, encoded] = dataUrl.split(','), mime = header.slice(5, -7);
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    body.append(references.length === 1 ? 'image' : 'image[]', new Blob([bytes], { type: mime }), `reference-${index + 1}.${mime === 'image/jpeg' ? 'jpg' : mime.slice(6)}`);
  });
  return { url: `${baseUrl}/images/edits`, body, json: false };
}

export function imageResult(payload: unknown): { b64_json?: unknown; url?: unknown } {
  const value = payload as { data?: { b64_json?: unknown; url?: unknown }[]; output?: { choices?: { message?: { content?: { image?: unknown }[] } }[] } };
  if (Array.isArray(value?.data) && value.data.length === 1 && value.data[0]) return value.data[0];
  const choices = value?.output?.choices;
  const images = choices?.length === 1 ? choices[0].message?.content?.filter(part => typeof part.image === 'string') : undefined;
  if (images?.length === 1) return { url: images[0].image };
  throw new Error('图片服务没有返回可用图片。');
}

export const IMAGE_REQUEST_ERRORS: Record<string, string> = {
  IMAGE_EDIT_QUOTA: '参考图编辑调用被百炼的“仅使用免费额度”限制拦截，请检查该模型的可用额度和调用设置。',
  IMAGE_REFERENCE_UNSUPPORTED: '参考图生成请求被拒绝，请确认所选模型支持图片编辑及当前接口格式；参考图未被丢弃重试。',
  IMAGE_AUTH_REJECTED: '图像服务拒绝认证，请检查 API Key 和模型权限。',
  IMAGE_RATE_LIMIT: '图像服务额度或速率已达上限。',
  IMAGE_RESULT_TOO_LARGE: '模型已经返回图片，但图片超过工作台8 MiB的保存上限。请降低画布输出尺寸后重试。',
  IMAGE_RESULT_INVALID_FORMAT: '模型已返回结果，但图片不是有效的PNG、JPEG或WebP文件。',
  IMAGE_RESULT_DOWNLOAD_FAILED: '模型已返回图片地址，但工作台无法安全下载该图片。请重试或检查模型返回的图片地址。',
  IMAGE_RESPONSE_TOO_LARGE: '模型返回数据超过工作台12 MiB传输上限。请使用图片地址响应或降低输出尺寸。',
};

export function imageRequestError(status: number, body: Uint8Array, references: boolean): Error {
  let code: unknown;
  try { const payload = JSON.parse(new TextDecoder().decode(body)); code = payload?.code ?? payload?.error?.code; } catch { /* Never display arbitrary provider bodies. */ }
  const key = code === 'AllocationQuota.FreeTierOnly' ? 'IMAGE_EDIT_QUOTA'
    : status === 401 || status === 403 ? 'IMAGE_AUTH_REJECTED'
    : status === 429 ? 'IMAGE_RATE_LIMIT'
    : references && [400, 404, 405, 415, 422].includes(status) ? 'IMAGE_REFERENCE_UNSUPPORTED' : '';
  return new Error(IMAGE_REQUEST_ERRORS[key] ?? '生图接口请求失败或未返回可用图片，请检查模型、接口兼容性和跨域设置。');
}
