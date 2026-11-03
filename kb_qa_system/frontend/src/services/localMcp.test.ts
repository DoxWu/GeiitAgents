import { webcrypto } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { validateCapability } from '@/agents/capabilities';
import { ensureLocalMcpConnected, localMcpInputContract, localMcpResource, type LocalMcpPackage, type LocalMcpTool } from './localMcp';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('./workbenchModel', () => ({ isDesktop: () => true }));

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
const pkg: LocalMcpPackage = { id: '27272727-2727-4272-8272-272727272727', ecosystem: 'npm', name: '@example/server', version: '1.2.3', entryPoints: ['server'] };
const tool = (inputSchema: Record<string, unknown>): LocalMcpTool => ({ name: 'search', description: 'Search local records', inputSchema });

it('maps scalar MCP arguments to typed, required agent fields', () => {
  expect(localMcpInputContract(tool({ type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' }, active: { type: 'boolean' } }, required: ['query'] })))
    .toMatchObject({ mode: 'fields', fields: [{ key: 'query', required: true }, { key: 'limit', required: false }, { key: 'active', type: 'boolean' }] });
});

it('uses a JSON object contract for nested MCP arguments and supports no-argument tools', () => {
  expect(localMcpInputContract(tool({ type: 'object', properties: { filter: { type: 'object' } } })))
    .toMatchObject({ mode: 'json', fields: [{ key: 'arguments', type: 'string', required: false }] });
  expect(localMcpInputContract(tool({ type: 'object', properties: {} }))).toMatchObject({ mode: 'json' });
});

it('builds a private-only MCP capability with a scalar result contract', () => {
  const config = { connectionId: '37373737-3737-4373-8373-373737373737', installationId: pkg.id, entryPoint: 'server', args: [] };
  const definition = tool({ type: 'object', properties: { query: { type: 'string' } } });
  const resource = localMcpResource(pkg, config, definition, localMcpInputContract(definition), { API_TOKEN: 'private' });
  expect(validateCapability(resource)).toMatchObject({ transport: 'stdio', localInputMode: 'fields', localEnv: { API_TOKEN: 'private' }, outputFields: [{ key: 'result', type: 'string' }] });
  expect(() => validateCapability({ ...resource, sharedId: '47474747-4747-4474-8474-474747474747' })).toThrow('私有');
});

it('discovers and authorizes the first task after a native not-connected response', async () => {
  vi.stubGlobal('navigator', { userAgent: 'Windows' });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const config = { connectionId: '37373737-3737-4373-8373-373737373737', installationId: pkg.id, entryPoint: 'server', args: [] };
  const definition = tool({ type: 'object', properties: { query: { type: 'string' } } });
  const resource = localMcpResource(pkg, config, definition, localMcpInputContract(definition), {});
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === 'mcp_packages') return [pkg];
    if (command === 'mcp_status') throw 'MCP_NOT_CONNECTED';
    if (command === 'mcp_discover') return [definition];
    return undefined;
  });
  await ensureLocalMcpConnected([resource], crypto.randomUUID(), new AbortController().signal);
  expect(confirm).toHaveBeenCalledOnce();
  expect(mocks.invoke).toHaveBeenCalledWith('mcp_approve', expect.objectContaining({ tools: ['search'] }));
  confirm.mockRestore();
});
