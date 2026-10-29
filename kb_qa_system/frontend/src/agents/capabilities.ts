import { validateFunction, type WorkflowFunction } from '@/workflows/functions';
import type { AgentField } from './definition';

export interface CapabilityResource {
  id: string; name: string; kind: 'tool' | 'skill' | 'mcp'; version: number; description: string;
  content: string; fn?: WorkflowFunction; endpoint?: string; toolName?: string;
  inputFields?: AgentField[]; outputFields?: AgentField[];
  sharedId?: string;
}
export function validateCapability(value: unknown): CapabilityResource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('能力资源格式无效。');
  const r = value as CapabilityResource;
  if (Object.keys(r).some(k => !['id', 'name', 'kind', 'version', 'description', 'content', 'fn', 'endpoint', 'toolName', 'inputFields', 'outputFields', 'sharedId'].includes(k))
    || typeof r.id !== 'string' || !/^[\da-f-]{36}$/i.test(r.id) || typeof r.name !== 'string' || !r.name.trim() || r.name.length > 100
    || !['tool', 'skill', 'mcp'].includes(r.kind) || !Number.isSafeInteger(r.version) || r.version < 1 || r.version > 1000000
    || typeof r.description !== 'string' || r.description.length > 300 || typeof r.content !== 'string' || r.content.length > 5000
    || r.sharedId !== undefined && (typeof r.sharedId !== 'string' || !/^[\da-f-]{36}$/i.test(r.sharedId))) throw new Error('能力资源字段无效。');
  if (r.kind === 'tool') validateFunction(r.fn);
  else if (r.fn !== undefined) throw new Error('只有工具资源可包含函数。');
  if (r.kind === 'mcp') {
    const url = new URL(r.endpoint ?? '');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port && url.port !== '443' || !r.toolName || !/^[\w.-]{1,80}$/.test(r.toolName)) throw new Error('MCP 需要不含凭据的 HTTPS 地址和工具名。');
    validateFunction({ id: r.id, name: r.name, description: r.description, version: r.version, code: 'return {};', reviewed: false, inputFields: r.inputFields, outputFields: r.outputFields });
  } else if (r.endpoint !== undefined || r.toolName !== undefined || r.inputFields !== undefined || r.outputFields !== undefined) throw new Error('连接字段只适用于 MCP。');
  return structuredClone(r);
}
