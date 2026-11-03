import { validateFunction, type WorkflowFunction } from '@/workflows/functions';
import type { AgentField } from './definition';

export interface CapabilityResource {
  id: string; name: string; kind: 'tool' | 'skill' | 'mcp'; version: number; description: string;
  content: string; fn?: WorkflowFunction; endpoint?: string; toolName?: string;
  inputFields?: AgentField[]; outputFields?: AgentField[];
  transport?: 'https' | 'stdio';
  localPackage?: { id: string; ecosystem: 'npm' | 'python'; name: string; version: string; entryPoints: string[] };
  localConnectionId?: string; localEntryPoint?: string; localArgs?: string[]; localEnv?: Record<string, string>;
  localInputMode?: 'fields' | 'json';
  sharedId?: string;
}
export function validateCapability(value: unknown): CapabilityResource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('能力资源格式无效。');
  const r = value as CapabilityResource;
  if (Object.keys(r).some(k => !['id', 'name', 'kind', 'version', 'description', 'content', 'fn', 'endpoint', 'toolName', 'inputFields', 'outputFields', 'transport', 'localPackage', 'localConnectionId', 'localEntryPoint', 'localArgs', 'localEnv', 'localInputMode', 'sharedId'].includes(k))
    || typeof r.id !== 'string' || !/^[\da-f-]{36}$/i.test(r.id) || typeof r.name !== 'string' || !r.name.trim() || r.name.length > 100
    || !['tool', 'skill', 'mcp'].includes(r.kind) || !Number.isSafeInteger(r.version) || r.version < 1 || r.version > 1000000
    || typeof r.description !== 'string' || r.description.length > 300 || typeof r.content !== 'string' || r.content.length > 5000
    || r.sharedId !== undefined && (typeof r.sharedId !== 'string' || !/^[\da-f-]{36}$/i.test(r.sharedId))) throw new Error('能力资源字段无效。');
  if (r.kind === 'tool') validateFunction(r.fn);
  else if (r.fn !== undefined) throw new Error('只有工具资源可包含函数。');
  if (r.kind === 'mcp') {
    const local = r.transport === 'stdio';
    if (r.transport !== undefined && !['https', 'stdio'].includes(r.transport)) throw new Error('MCP 连接方式无效。');
    if (local) {
      if (r.sharedId) throw new Error('本机 MCP 只能保存在私有仓库。');
      const pkg = r.localPackage;
      const validName = pkg?.ecosystem === 'npm'
        ? /^(?:[a-z0-9][a-z0-9._-]*|@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)$/.test(pkg.name)
        : pkg?.ecosystem === 'python' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pkg.name);
      if (r.endpoint !== undefined || !/^[\da-f-]{36}$/i.test(r.localConnectionId ?? '') || !pkg || !/^[\da-f-]{36}$/i.test(pkg.id) || !validName || pkg.name.length > 160
        || !(pkg.ecosystem === 'npm' ? /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/ : /^\d[0-9A-Za-z.+-]*$/).test(pkg.version) || pkg.version.length > 60
        || !Array.isArray(pkg.entryPoints) || pkg.entryPoints.length < 1 || pkg.entryPoints.length > 30
        || pkg.entryPoints.some(entry => !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/.test(entry)) || !pkg.entryPoints.includes(r.localEntryPoint ?? '')
        || !Array.isArray(r.localArgs) || r.localArgs.length > 30 || r.localArgs.some(arg => typeof arg !== 'string' || arg.length > 2048 || arg.includes('\0'))
        || r.localEnv !== undefined && (!r.localEnv || typeof r.localEnv !== 'object' || Array.isArray(r.localEnv)
          || Object.entries(r.localEnv).length > 30 || Object.entries(r.localEnv).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(key) || typeof value !== 'string' || value.length > 4096 || value.includes('\0')
            || /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|PYTHONHOME|PYTHONPATH|PYTHONSTARTUP|NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|NPM_|PIP_)/i.test(key)))
        || !r.toolName || !/^[\w.-]{1,80}$/.test(r.toolName) || !r.inputFields?.length || !r.outputFields?.length
        || !['fields', 'json'].includes(r.localInputMode ?? '')
        || r.outputFields.length !== 1 || r.outputFields[0].key !== 'result' || r.outputFields[0].type !== 'string' || !r.outputFields[0].required
        || r.localInputMode === 'json' && (r.inputFields.length !== 1 || r.inputFields[0].key !== 'arguments' || r.inputFields[0].type !== 'string' || r.inputFields[0].required)) throw new Error('本机 MCP 安装包、入口或工具契约无效。');
    } else {
      const url = new URL(r.endpoint ?? '');
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port && url.port !== '443' || !r.toolName || !/^[\w.-]{1,80}$/.test(r.toolName)
        || r.localPackage !== undefined || r.localConnectionId !== undefined || r.localEntryPoint !== undefined || r.localArgs !== undefined || r.localEnv !== undefined || r.localInputMode !== undefined) throw new Error('MCP 需要不含凭据的 HTTPS 地址和工具名。');
    }
    validateFunction({ id: r.id, name: r.name, description: r.description, version: r.version, code: 'return {};', reviewed: false, inputFields: r.inputFields, outputFields: r.outputFields });
  } else if (r.endpoint !== undefined || r.toolName !== undefined || r.inputFields !== undefined || r.outputFields !== undefined || r.transport !== undefined || r.localPackage !== undefined || r.localConnectionId !== undefined || r.localEntryPoint !== undefined || r.localArgs !== undefined || r.localEnv !== undefined || r.localInputMode !== undefined) throw new Error('连接字段只适用于 MCP。');
  return structuredClone(r);
}
export function hasLocalMcp(resource: CapabilityResource): boolean { return resource.kind === 'mcp' && resource.transport === 'stdio'; }
export function workflowHasLocalMcp(workflow: { nodes?: { agent?: { capabilities?: CapabilityResource[] }; capability?: CapabilityResource }[] }): boolean {
  return Boolean(Array.isArray(workflow?.nodes) && workflow.nodes.some(node => node && (node.capability && hasLocalMcp(node.capability) || node.agent?.capabilities?.some(hasLocalMcp))));
}
