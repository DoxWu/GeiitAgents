import { apiClient } from './client';
import { validateCapability, type CapabilityResource } from '@/agents/capabilities';
import { stableJson } from '@/utils/stableJson';
export interface SharedCapability { id: string; organizationId: number | null; ownerId: number; status: 'pending' | 'published' | 'disabled'; resource: CapabilityResource }
export const listCapabilities = () => apiClient.get<SharedCapability[]>('/capabilities', { cache: 'no-store' });
export const publishCapability = (resource: CapabilityResource, organizationId: number | null) => apiClient.post<SharedCapability>('/capabilities', { resource, organizationId });
export const reviewCapability = (id: string, approved: boolean) => apiClient.post<SharedCapability>(`/capabilities/${id}/review`, { approved });
export const disableCapability = (id: string) => apiClient.delete<void>(`/capabilities/${id}`);
export async function verifyCapability(resource: CapabilityResource, signal: AbortSignal) {
  if (!resource.sharedId) return resource;
  const item = await apiClient.get<SharedCapability>(`/capabilities/${resource.sharedId}`, { signal, cache: 'no-store' });
  const remote = validateCapability(item.resource), local = structuredClone(resource); delete local.sharedId;
  if (local.fn) local.fn.reviewed = false;
  if (remote.fn) remote.fn.reviewed = false;
  if (stableJson(local) !== stableJson(remote)) throw new Error('共享能力版本不匹配，请重新导入并审阅。');
  return resource;
}
export async function callMcp(resource: CapabilityResource, inputs: Record<string, string | number | boolean>, signal: AbortSignal) {
  if (!resource.sharedId) throw new Error('MCP 连接须先发布并经管理员审核。');
  const result = await apiClient.post<{ output: Record<string, string | number | boolean> }>(`/capabilities/${resource.sharedId}/call`, { inputs, consent: true }, { signal, cache: 'no-store' });
  return result.output;
}
