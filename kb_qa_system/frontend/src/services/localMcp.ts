import { isDesktop } from './workbenchModel';
import type { CapabilityResource } from '@/agents/capabilities';
import type { AgentField } from '@/agents/definition';

export interface LocalMcpPackage { id: string; ecosystem: 'npm' | 'python'; name: string; version: string; entryPoints: string[] }
export interface LocalMcpTool { name: string; description: string; inputSchema: Record<string, unknown> }
export interface LocalMcpConfig { connectionId: string; installationId: string; entryPoint: string; args: string[] }
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export const isLocalMcpDesktop = () => isDesktop() && /Windows/i.test(navigator.userAgent);
class LocalMcpError extends Error { constructor(readonly code: string, message: string) { super(message); } }

function friendlyError(error: unknown): Error {
  const code = String(error instanceof Error ? error.message : error);
  const messages: Record<string, string> = {
    MCP_PACKAGE_SPEC: '请填写有效的包名和精确版本。npm 版本需完整填写 x.y.z。', MCP_REGISTRY: '包源无效；npm 仅支持 npmjs.org，Python 仅支持 PyPI 或阿里云 PyPI 镜像。', MCP_RUNTIME: '没有找到可用的 Node.js/npm 或 Python/pip 运行时，请先安装并重启应用。',
    MCP_INSTALL: '安装失败。请检查包名、版本、官方仓库连接及 Windows wheel 兼容性。', MCP_TIMEOUT: '本次 MCP 操作超过时间限制，已取消。',
    MCP_BUSY: '本地 MCP 正忙，请等当前安装或工具调用完成。', MCP_CANCELLED: '本地 MCP 操作已取消。', MCP_ENTRY: '包没有可运行的 MCP 命令入口。',
    MCP_ENV: '环境变量含有受保护的系统或运行时配置。', MCP_SCHEMA: 'MCP 工具声明了当前无法安全映射的参数格式。',
    MCP_NOT_CONNECTED: '本机 MCP 会话已结束，请重新运行并授权。', MCP_NOT_APPROVED: '该工具未在本次任务中授权，请重新连接并选择工具。',
    MCP_PROTOCOL: 'MCP 服务返回了无效或不支持的协议响应。', MCP_TOOL: 'MCP 工具执行失败；本次会话已关闭。', MCP_START: '无法启动本机 MCP 服务，请检查入口及运行时。',
  };
  return new LocalMcpError(code, messages[code] ?? (/^MCP_[A-Z_]+$/.test(code) ? '本地 MCP 操作失败（' + code + '）。' : code.slice(0, 500)));
}
async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isLocalMcpDesktop()) throw new Error('本机 MCP 仅可在 Windows 桌面版使用。');
  const { invoke: call } = await import('@tauri-apps/api/core');
  try { return await call<T>(command, args); } catch (error) { throw friendlyError(error); }
}
export const listLocalMcpPackages = () => invoke<LocalMcpPackage[]>('mcp_packages');
export const installLocalMcpPackage = (ecosystem: LocalMcpPackage['ecosystem'], name: string, version: string, registry: string, requestId: string = crypto.randomUUID()) =>
  invoke<LocalMcpPackage>('mcp_install', { requestId, ecosystem, name, version, registry });
export const removeLocalMcpPackage = (installationId: string) => invoke<void>('mcp_remove', { installationId });
export async function discoverLocalMcp(sessionId: string, config: LocalMcpConfig, env: Record<string, string>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const requestId = crypto.randomUUID(), cancel = () => { void invoke<void>('mcp_cancel', { requestId }).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try { const result = await invoke<LocalMcpTool[]>('mcp_discover', { sessionId, requestId, config, env }); signal?.throwIfAborted(); return result; }
  finally { signal?.removeEventListener('abort', cancel); }
}
export const approveLocalMcp = (sessionId: string, config: LocalMcpConfig, tools: string[]) => invoke<void>('mcp_approve', { sessionId, config, tools });
export const statusLocalMcp = (sessionId: string, config: LocalMcpConfig, tool: string, env: Record<string, string> = {}) => invoke<void>('mcp_status', { sessionId, config, tool, env });
export const callLocalMcp = (sessionId: string, config: LocalMcpConfig, tool: string, arguments_: Record<string, unknown>, requestId: string = crypto.randomUUID(), env: Record<string, string> = {}) =>
  invoke<unknown>('mcp_call', { sessionId, requestId, config, tool, arguments: arguments_, env });
export const cancelLocalMcp = (requestId: string) => invoke<void>('mcp_cancel', { requestId });
export const disconnectLocalMcpSession = (sessionId: string) => isLocalMcpDesktop() ? invoke<void>('mcp_disconnect', { sessionId }) : Promise.resolve();
export const lockLocalMcp = () => isLocalMcpDesktop() ? invoke<void>('mcp_lock') : Promise.resolve();

export async function ensureLocalMcpConnected(resources: CapabilityResource[], sessionId: string, signal: AbortSignal) {
  const groups = new Map<string, CapabilityResource[]>();
  for (const resource of resources) if (resource.kind === 'mcp' && resource.transport === 'stdio') groups.set(resource.localConnectionId!, [...(groups.get(resource.localConnectionId!) ?? []), resource]);
  if (!groups.size) return;
  signal.throwIfAborted();
  if (!isLocalMcpDesktop()) throw new Error('本机 MCP 仅可在 Windows 桌面版运行。');
  const configurations = [...groups.values()].map(group => ({ group, config: localMcpConfig(group[0]) }));
  for (const { group, config } of configurations) {
    const env = (value: Record<string, string> = {}) => Object.keys(value).sort().map(key => [key, value[key]]);
    if (group.some(item => JSON.stringify(localMcpConfig(item)) !== JSON.stringify(config)
      || JSON.stringify(env(item.localEnv)) !== JSON.stringify(env(group[0].localEnv)))) throw new Error('同一 MCP 连接中的包、参数或环境变量配置不一致，请删除重复绑定后重新添加。');
  }
  const packages = await listLocalMcpPackages();
  for (const { config } of configurations) if (!packages.some(item => item.id === config.installationId && item.entryPoints.includes(config.entryPoint))) throw new Error('此备份引用的本机 MCP 包未安装，请先在本机资源仓库重新安装。');
  try {
    for (const { group, config } of configurations) for (const resource of group) await statusLocalMcp(sessionId, config, resource.toolName!, resource.localEnv);
    return;
  } catch (error) {
    if (!(error instanceof LocalMcpError) || !['MCP_NOT_CONNECTED', 'MCP_NOT_APPROVED'].includes(error.code)) throw error;
  }
  signal.throwIfAborted();
  const servers = configurations.map(({ group }) => ({ name: group[0].localPackage?.name ?? '本机包', tools: group.map(item => item.toolName) }));
  const summary = servers.map(item => item.name + '：' + item.tools.join('、')).join('\n');
  if (!window.confirm('将为本次任务启动并授权以下本机 MCP 工具：\n' + summary + '\n\n这些 npm/Python 包不是沙箱，会以当前 Windows 用户权限访问本机文件与服务。任务结束后会关闭进程。是否继续？')) throw new Error('用户取消了本次本机 MCP 授权。');
  for (const { group, config } of configurations) {
    signal.throwIfAborted();
    const env = Object.assign({}, ...group.map(item => item.localEnv ?? {}));
    const discovered = await discoverLocalMcp(sessionId, config, env, signal);
    const tools = [...new Set(group.map(item => item.toolName!))];
    if (!tools.every(tool => discovered.some(item => item.name === tool))) throw new Error('重新连接后发现的工具与已保存快照不匹配。');
    await approveLocalMcp(sessionId, config, tools);
  }
}

function objectSchemaFields(schema: Record<string, unknown>): AgentField[] | null {
  const properties = schema.properties;
  if (schema.type !== 'object' || !properties || typeof properties !== 'object' || Array.isArray(properties) || Object.keys(properties).length > 10) return null;
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (required.some(key => typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(properties, key))) throw new Error('MCP 工具的 required 字段格式无效。');
  const fields: AgentField[] = [];
  for (const [key, raw] of Object.entries(properties)) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const field = raw as Record<string, unknown>;
    if (!['string', 'number', 'boolean'].includes(String(field.type))) return null;
    fields.push({ key, label: key, type: field.type as AgentField['type'], required: required.includes(key), description: typeof field.description === 'string' ? field.description.slice(0, 240) : '' });
  }
  return fields.length ? fields : null;
}
export function localMcpInputContract(tool: LocalMcpTool): { mode: 'fields' | 'json'; fields: AgentField[] } {
  const mapped = objectSchemaFields(tool.inputSchema);
  if (mapped) return { mode: 'fields', fields: mapped };
  return { mode: 'json', fields: [{ key: 'arguments', label: 'MCP 输入参数 JSON', type: 'string', required: false, description: '符合该工具 JSON Schema 的对象。无参数时可留空。' }] };
}
export function localMcpResource(pkg: LocalMcpPackage, config: LocalMcpConfig, tool: LocalMcpTool, contract: ReturnType<typeof localMcpInputContract>, env: Record<string, string>): CapabilityResource {
  return { id: crypto.randomUUID(), kind: 'mcp', transport: 'stdio', localInputMode: contract.mode, name: tool.name, description: tool.description.slice(0, 300), version: 1, content: '',
    toolName: tool.name, inputFields: contract.fields, outputFields: [{ key: 'result', label: '结果', type: 'string', required: true, description: 'MCP 工具返回的文本或 JSON。' }],
    localPackage: pkg, localConnectionId: config.connectionId, localEntryPoint: config.entryPoint, localArgs: config.args, localEnv: env };
}
export function localMcpConfig(resource: CapabilityResource): LocalMcpConfig {
  if (resource.kind !== 'mcp' || resource.transport !== 'stdio' || !resource.localPackage || !resource.localEntryPoint) throw new Error('本机 MCP 定义无效。');
  return { connectionId: resource.localConnectionId!, installationId: resource.localPackage.id, entryPoint: resource.localEntryPoint, args: resource.localArgs ?? [] };
}
export type { Invoke };
