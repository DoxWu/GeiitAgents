import { apiClient } from '@/api/client';
import { workImageFromDataUrl } from '@/services/workbenchImages';
import type { WorkImage } from '@/types/workbench';
import { imageSizeValue, validateImagePrompt, type ImageSize } from '@/services/imageGeneration';

export interface ServerImageModel { id: string; model: string }

export async function listServerImageModels(): Promise<ServerImageModel[]> {
  const result = await apiClient.get<{ models: ServerImageModel[] }>('/private-models/server-images');
  return result.models;
}

export async function generateServerImage(endpointId: string, prompt: string, consent: boolean, signal: AbortSignal, size?: ImageSize): Promise<WorkImage> {
  if (!consent) throw new Error('发送图片描述到服务端模型前需要明确授权。');
  const result = await apiClient.post<{ data_url: string }>('/private-models/server-images/generate', {
    endpoint_id: endpointId, prompt: validateImagePrompt(prompt), consent, size: imageSizeValue(size),
  }, { signal, cache: 'no-store', redirect: 'error' });
  return workImageFromDataUrl(result.data_url, 'server-generated-image.png');
}
