import { apiClient } from './client';
import { hasLocalMcp, validateCapability, type CapabilityResource } from '@/agents/capabilities';
import { stableJson } from '@/utils/stableJson';
import { callLocalMcp, cancelLocalMcp, isLocalMcpDesktop as isDesktop, localMcpConfig, statusLocalMcp } from '@/services/localMcp';
export interface SharedCapability { id: string; organizationId: number | null; ownerId: number; status: 'pending' | 'published' | 'disabled'; resource: CapabilityResource }
export const listCapabilities = () => apiClient.get<SharedCapability[]>('/capabilities', { cache: 'no-store' });
export const publishCapability = (resource: CapabilityResource, organizationId: number | null) => {
  if (hasLocalMcp(resource)) throw new Error('本机 MCP 只能保存在私有能力仓库。');
  return apiClient.post<SharedCapability>('/capabilities', { resource, organizationId });
};
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
export async function callMcp(resource: CapabilityResource, inputs: Record<string, string | number | boolean>, signal: AbortSignal, sessionId: string) {
  if (resource.transport === 'stdio') {
    if (!isDesktop() || !resource.toolName) throw new Error('本机 MCP 仅能在桌面版运行。');
    const config = localMcpConfig(resource);
    await statusLocalMcp(sessionId, config, resource.toolName, resource.localEnv);
    signal.throwIfAborted();
    const requestId = crypto.randomUUID();
    const abort = () => { void cancelLocalMcp(requestId).catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const args = resource.localInputMode === 'json'
        ? JSON.parse(typeof inputs.arguments === 'string' && inputs.arguments.trim() ? inputs.arguments : '{}') as Record<string, unknown>
        : inputs;
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('MCP JSON 输入必须是对象。');
      const output = await callLocalMcp(sessionId, config, resource.toolName, args, requestId, resource.localEnv);
      signal.throwIfAborted();
      const result = output && typeof output === 'object' && !Array.isArray(output) && Object.keys(output).length === 1 && 'result' in output && typeof output.result === 'string' ? output.result : JSON.stringify(output);
      if (result.length > 100000) throw new Error('本机 MCP 返回结果超过 100000 字符。');
      return { result };
    } finally { signal.removeEventListener('abort', abort); }
  }
  if (!resource.sharedId) throw new Error('MCP 连接须先发布并经管理员审核。');
  const result = await apiClient.post<{ output: Record<string, string | number | boolean> }>(`/capabilities/${resource.sharedId}/call`, { inputs, consent: true }, { signal, cache: 'no-store' });
  return result.output;
}
