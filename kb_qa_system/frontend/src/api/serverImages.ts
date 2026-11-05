import { apiClient } from '@/api/client';
import { generatedImageFromDataUrl } from '@/services/generatedImages';
import type { GeneratedWorkImage, WorkImage } from '@/types/workbench';
import { imageSizeValue, validateImagePrompt, imageOutputFields, type ImageOutputOptions, type ImageSize } from '@/services/imageGeneration';
import { imageReferenceData } from '@/services/imageRequest';

export interface ServerImageModel { id: string; model: string }

export async function listServerImageModels(): Promise<ServerImageModel[]> {
  const result = await apiClient.get<{ models: ServerImageModel[] }>('/private-models/server-images');
  return result.models;
}

export async function generateServerImage(endpointId: string, prompt: string, consent: boolean, signal: AbortSignal, size?: ImageSize, references?: WorkImage[], output?: ImageOutputOptions): Promise<GeneratedWorkImage> {
  if (!consent) throw new Error('发送图片描述及参考图到服务端模型前需要明确授权。');
  const referenceImages = imageReferenceData(references);
  const result = await apiClient.post<{ data_url: string }>('/private-models/server-images/generate', {
    endpoint_id: endpointId, prompt: validateImagePrompt(prompt), consent, size: imageSizeValue(size), ...imageOutputFields(output, referenceImages), ...(referenceImages.length ? { reference_images: referenceImages } : {}),
  }, { signal, cache: 'no-store', redirect: 'error' });
  return generatedImageFromDataUrl(result.data_url, 'server-generated-image.png');
}
