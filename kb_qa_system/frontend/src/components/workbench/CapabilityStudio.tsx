import { useEffect, useState } from 'react';
import { useWorkbenchStore } from '@/store/workbenchStore';
import { useAuthStore } from '@/store/authStore';
import { useOrganizationOptions } from '@/hooks/useOrganizationOptions';
import { newFunction } from '@/workflows/functions';
import { newWorkflowNode } from '@/workflows/definition';
import { hasLocalMcp, validateCapability, type CapabilityResource } from '@/agents/capabilities';
import { disableCapability, listCapabilities, publishCapability, reviewCapability, type SharedCapability } from '@/api/capabilities';
import { FunctionNodeFields } from './FunctionNodeFields';
import { useWorkbenchFence } from '@/hooks/useWorkbenchFence';
import { Hint } from './Hint';
import { approveLocalMcp, cancelLocalMcp, discoverLocalMcp, disconnectLocalMcpSession, installLocalMcpPackage, isLocalMcpDesktop, listLocalMcpPackages, localMcpInputContract, localMcpResource, removeLocalMcpPackage, type LocalMcpPackage, type LocalMcpTool } from '@/services/localMcp';

function fresh(kind: CapabilityResource['kind']): CapabilityResource {
  const fn = newFunction();
  return { id: crypto.randomUUID(), kind, name: '新能力', version: 1, description: '', content: '',
    ...(kind === 'tool' ? { fn } : kind === 'mcp' ? { endpoint: 'https://example.com/mcp', toolName: 'lookup', inputFields: fn.inputFields, outputFields: fn.outputFields } : {}) };
}
export function CapabilityStudio() {
  const store = useWorkbenchStore(), user = useAuthStore(s => s.user), orgs = useOrganizationOptions();
  const capture = useWorkbenchFence();
  const [draft, setDraft] = useState<CapabilityResource>(() => fresh('tool')), [scope, setScope] = useState('');
  const [shared, setShared] = useState<SharedCapability[]>([]), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [packages, setPackages] = useState<LocalMcpPackage[]>([]), [packageKind, setPackageKind] = useState<'npm' | 'python'>('npm'), [packageName, setPackageName] = useState(''), [packageVersion, setPackageVersion] = useState('');
  const [pythonRegistry, setPythonRegistry] = useState('https://pypi.org/simple');
  const [localPackage, setLocalPackage] = useState<LocalMcpPackage | null>(null), [entryPoint, setEntryPoint] = useState(''), [localArgs, setLocalArgs] = useState(''), [localEnv, setLocalEnv] = useState('{}'), [tools, setTools] = useState<LocalMcpTool[]>([]), [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [mcpSessionId, setMcpSessionId] = useState(() => crypto.randomUUID()), [installRequestId, setInstallRequestId] = useState('');
  useEffect(() => {
    setShared([]); setDraft(fresh('tool')); setLocalPackage(null); setEntryPoint(''); setLocalArgs(''); setLocalEnv('{}'); setTools([]); setSelectedTools([]); setNotice(''); setBusy(false);
    setMcpSessionId(crypto.randomUUID());
  }, [user?.id, store.unlocked]);
  useEffect(() => { const current = capture(); if (store.unlocked) void listLocalMcpPackages().then(items => { if (current()) setPackages(items); }).catch(() => { if (current()) setPackages([]); }); }, [store.unlocked, capture]);
  useEffect(() => () => { void disconnectLocalMcpSession(mcpSessionId).catch(() => {}); }, [mcpSessionId]);
  useEffect(() => () => { if (installRequestId) void cancelLocalMcp(installRequestId).catch(() => {}); }, [installRequestId]);
  function patch(value: Partial<CapabilityResource>) { setDraft(d => ({ ...d, ...value, sharedId: undefined })); }
  function selectResource(resource: CapabilityResource) {
    void disconnectLocalMcpSession(mcpSessionId).catch(() => {}); setMcpSessionId(crypto.randomUUID());
    setDraft(structuredClone(resource)); setTools([]); setSelectedTools([]);
    if (resource.transport === 'stdio' && resource.localPackage) {
      setLocalPackage(packages.find(item => item.id === resource.localPackage!.id) ?? resource.localPackage);
      setEntryPoint(resource.localEntryPoint ?? resource.localPackage.entryPoints[0] ?? ''); setLocalArgs((resource.localArgs ?? []).join('\n'));
      setLocalEnv(JSON.stringify(resource.localEnv ?? {}, null, 2));
    } else { setLocalPackage(null); setEntryPoint(''); setLocalArgs(''); setLocalEnv('{}'); }
  }
  function preparedDraft() {
    if (!hasLocalMcp(draft)) return validateCapability(draft);
    const env = JSON.parse(localEnv) as Record<string, string>;
    if (!env || Array.isArray(env) || typeof env !== 'object' || Object.values(env).some(value => typeof value !== 'string')) throw new Error('环境变量必须是字符串 JSON 对象。');
    const args = localArgs.split(/\r?\n/).filter(Boolean);
    return validateCapability({ ...draft, localPackage: localPackage ?? draft.localPackage, localEntryPoint: entryPoint, localArgs: args, localEnv: env });
  }
  async function action(operation: (current: () => boolean) => Promise<void>) {
    const current = capture();
    setBusy(true); setNotice(''); try { await operation(current); } catch (e) { if (current()) setNotice(e instanceof Error ? e.message : '操作失败'); } finally { if (current()) setBusy(false); }
  }
  async function installPackage(requestId: string) {
    await action(async current => {
      setNotice('正在安装 ' + packageName.trim() + '@' + packageVersion.trim() + '，可在左侧取消；依赖下载最长等待 10 分钟。');
      try {
        const registry = packageKind === 'npm' ? 'https://registry.npmjs.org' : pythonRegistry;
        const item = await installLocalMcpPackage(packageKind, packageName.trim(), packageVersion.trim(), registry, requestId);
        if (!current()) return;
        setPackages(items => [item, ...items.filter(p => p.id !== item.id)]);
        setLocalPackage(item); setEntryPoint(item.entryPoints[0]); setTools([]); setSelectedTools([]);
        setNotice('已安装 ' + item.name + '@' + item.version + '。');
      } finally { if (current()) setInstallRequestId(''); }
    });
  }
  return <section className="grid min-h-0 flex-1 overflow-auto lg:grid-cols-[260px_minmax(0,1fr)]" aria-label="资源仓库">
    <aside className="grid content-start gap-2 border-r border-line p-4"><h2 className="text-sm font-semibold">工具 / 技能 / MCP</h2>
      <div className="flex flex-wrap gap-1">{(['tool', 'skill', 'mcp'] as const).map(kind => <button key={kind} disabled={busy} className="work-command" onClick={() => selectResource(fresh(kind))}>新建{kind === 'tool' ? '工具' : kind === 'skill' ? '技能' : 'MCP'}</button>)}</div>
      {store.capabilities.map(r => <button className="work-command text-left" disabled={busy} key={r.id} onClick={() => selectResource(r)}>{r.name} · v{r.version} · {r.kind}</button>)}
      {installRequestId && <button type="button" className="work-command" onClick={() => void cancelLocalMcp(installRequestId).catch(() => {})}>取消安装</button>}
      <button className="work-command" disabled={busy || !user || !store.unlocked} onClick={() => void action(async current => { const items = await listCapabilities(); if (current()) setShared(items); })}>刷新组织 / 共有仓库</button>
      {shared.map(item => <article className="grid gap-2 border border-line p-2 text-xs" key={item.id}><strong>{item.resource.name} · v{item.resource.version}</strong><span>{item.organizationId ? orgs.find(o => o.id === item.organizationId)?.name : '全站'} · {item.status}</span>
        {item.ownerId === user?.id && item.status !== 'disabled' && <button className="work-command" disabled={busy} onClick={() => void action(async current => { await disableCapability(item.id); if (!current()) return; const items = await listCapabilities(); if (current()) setShared(items); })}>撤回共享版本</button>}
        {item.status === 'published' && <button className="work-command" disabled={!store.unlocked || busy} onClick={() => void action(async current => { const r = validateCapability({ ...item.resource, sharedId: item.id }); if (r.fn) r.fn.reviewed = false; await store.saveCapability(r); if (current()) { setDraft(r); setNotice('已导入固定版本；函数需检查后确认。'); } })}>导入私有仓库</button>}
        {(user?.is_superuser || item.organizationId && orgs.some(o => o.id === item.organizationId && o.role === 'org_admin')) && <div className="flex gap-2"><button className="work-command" disabled={busy} onClick={() => void action(async current => { await reviewCapability(item.id, true); if (!current()) return; const items = await listCapabilities(); if (current()) setShared(items); })}>批准</button><button className="work-command" disabled={busy} onClick={() => void action(async current => { await reviewCapability(item.id, false); if (!current()) return; const items = await listCapabilities(); if (current()) setShared(items); })}>停用</button></div>}
      </article>)}
    </aside>
    <fieldset disabled={!store.unlocked || busy} className="grid min-w-0 content-start gap-4 border-0 p-4 sm:p-6"><h1 className="text-lg font-semibold">能力资源 · {draft.kind}</h1>
      <label className="work-label">资源名称<input className="work-input" value={draft.name} maxLength={100} onChange={e => patch({ name: e.target.value })} /></label>
      <label className="work-label">用途说明<input className="work-input" value={draft.description} maxLength={300} onChange={e => patch({ description: e.target.value })} /></label>
      <label className="work-label">版本号<input type="number" className="work-input" min={1} max={1000000} value={draft.version} onChange={e => patch({ version: Number(e.target.value) })} /></label>
      {draft.kind === 'tool' && <FunctionNodeFields node={{ ...newWorkflowNode('function', 0), fn: draft.fn! }} onChange={value => value.fn && patch({ fn: value.fn })} />}
      {draft.kind === 'skill' && <label className="work-label">技能指令与示例<textarea className="work-input min-h-64" maxLength={5000} value={draft.content} onChange={e => patch({ content: e.target.value })} /></label>}
      {draft.kind === 'mcp' && <>
        <div className="work-label"><span><label htmlFor="local-mcp-transport">连接方式</label><Hint label="MCP 连接方式">远程 HTTPS 在已审核后由服务端代理调用。本机 stdio 仅限 Windows 桌面版，服务进程运行在当前用户权限下；它不是安全沙箱。安装包、入口、环境变量和已选工具随本机密钥库加密保存，但不会随共有仓库或工作流文件导出。</Hint></span><select id="local-mcp-transport" aria-label="MCP transport" className="work-input" value={draft.transport ?? 'https'} onChange={e => { void disconnectLocalMcpSession(mcpSessionId).catch(() => {}); setMcpSessionId(crypto.randomUUID()); const transport = e.target.value as 'https' | 'stdio'; setDraft(transport === 'stdio' ? { id: draft.id, name: draft.name, description: draft.description, version: 1, kind: 'mcp', content: '', transport } : { ...fresh('mcp'), id: draft.id, name: draft.name, description: draft.description }); setTools([]); setSelectedTools([]); setLocalPackage(null); setEntryPoint(''); setLocalArgs(''); setLocalEnv('{}'); setNotice(''); }}><option value="https">远程 HTTPS</option><option value="stdio" disabled={!isLocalMcpDesktop()}>本机 stdio（Windows 桌面版）</option></select></div>
        {draft.transport !== 'stdio' ? <><label className="work-label">MCP 地址<input className="work-input" value={draft.endpoint ?? ''} onChange={e => patch({ endpoint: e.target.value, transport: 'https' })} /></label><label className="work-label">允许调用的工具<input className="work-input" value={draft.toolName ?? ''} onChange={e => patch({ toolName: e.target.value, transport: 'https' })} /></label></> : <div className="grid gap-3 border border-line p-3">
          <div className="flex items-center gap-2"><span className="text-sm font-medium">安装本机 MCP 包</span><Hint label="包安装安全与要求">请先安装 Node.js（含 npm）或 Python（含 pip/venv），并重启应用；应用不会自动下载运行时。请核对包发布者与代码。npm 使用官方源；Python 可选择 PyPI 或阿里云镜像。安装时禁用 npm 生命周期脚本；Python 仅安装已有 wheel，不构建源码。包启动后可以访问当前 Windows 用户有权限读取的文件与服务。卸载仅删除应用管理的包目录。</Hint></div>
          <div className="grid gap-2 sm:grid-cols-[auto_1fr_1fr_auto]"><select aria-label="MCP 包类型" className="work-input" value={packageKind} onChange={e => setPackageKind(e.target.value as 'npm' | 'python')}><option value="npm">npm</option><option value="python">Python</option></select>{packageKind === 'python' && <select aria-label="Python 包源" className="work-input sm:col-span-4" value={pythonRegistry} onChange={e => setPythonRegistry(e.target.value)}><option value="https://pypi.org/simple">PyPI</option><option value="https://mirrors.aliyun.com/pypi/simple">阿里云 PyPI 镜像</option></select>}<input aria-label="MCP 包名" className="work-input" placeholder="包名" value={packageName} onChange={e => setPackageName(e.target.value)} /><input aria-label="MCP 包精确版本" className="work-input" placeholder="精确版本，如 1.2.3" value={packageVersion} onChange={e => setPackageVersion(e.target.value)} /><button type="button" className="work-command" disabled={busy || !isLocalMcpDesktop() || !packageName.trim() || !packageVersion.trim()} onClick={() => { const requestId = crypto.randomUUID(); setInstallRequestId(requestId); void installPackage(requestId); }}>安装</button></div>
          {packages.length > 0 && <label className="work-label">已安装包<select aria-label="已安装 MCP 包" className="work-input" value={localPackage?.id ?? ''} onChange={e => { const item = packages.find(p => p.id === e.target.value) ?? null; setLocalPackage(item); setEntryPoint(item?.entryPoints[0] ?? ''); setTools([]); setSelectedTools([]); }}><option value="">选择已安装包</option>{packages.map(item => <option key={item.id} value={item.id}>{item.ecosystem} · {item.name}@{item.version}</option>)}</select></label>}
          {localPackage && <><label className="work-label">启动入口<select aria-label="MCP 启动入口" className="work-input" value={entryPoint} onChange={e => setEntryPoint(e.target.value)}>{localPackage.entryPoints.map(item => <option key={item} value={item}>{item}</option>)}</select></label><div className="work-label"><span><label htmlFor="local-mcp-args">附加参数（每行一个）</label><Hint label="stdio 启动参数">参数按独立 argv 项传递，不经过 shell。启动目录固定为应用管理的包目录；环境清除后只保留最少系统变量和本表单内容。</Hint></span><textarea id="local-mcp-args" aria-label="MCP 附加参数" className="work-input min-h-16" value={localArgs} onChange={e => setLocalArgs(e.target.value)} /></div><div className="work-label"><span><label htmlFor="local-mcp-env">MCP 环境变量 JSON </label><Hint label="MCP 环境变量">例如填写 {"{\"API_TOKEN\":\"...\"}"}。环境变量随本机能力加密保存在密钥库，不共享或写入日志。PATH、运行时搜索路径和系统变量不可覆盖。</Hint></span><textarea id="local-mcp-env" aria-label="MCP 环境变量 JSON" className="work-input min-h-20 font-mono" value={localEnv} onChange={e => setLocalEnv(e.target.value)} /></div><button type="button" className="work-command justify-self-start" disabled={busy || !isLocalMcpDesktop()} onClick={() => void action(async current => { const config = { connectionId: draft.localConnectionId ?? draft.id, installationId: localPackage.id, entryPoint, args: localArgs.split(/\r?\n/).filter(Boolean) }; const env = JSON.parse(localEnv); if (!env || Array.isArray(env) || typeof env !== 'object' || Object.values(env).some(value => typeof value !== 'string')) throw new Error('环境变量必须是字符串 JSON 对象。'); if (!window.confirm('现在会启动 ' + localPackage.name + '@' + localPackage.version + ' 来读取工具定义，但不会执行已发现的工具。服务进程运行在当前 Windows 用户权限下。是否继续？')) return; try { const found = await discoverLocalMcp(mcpSessionId, config, env as Record<string, string>); if (!current()) { await disconnectLocalMcpSession(mcpSessionId).catch(() => {}); return; } setTools(found); setSelectedTools([]); setNotice('已发现 ' + found.length + ' 个工具，请选择并保存到私有仓库。'); } catch (error) { await disconnectLocalMcpSession(mcpSessionId).catch(() => {}); throw error; } })}>连接并发现工具</button></>}
          {tools.map(tool => <div className="flex items-start gap-2 text-sm" key={tool.name}><label className="flex items-start gap-2"><input type="checkbox" checked={selectedTools.includes(tool.name)} onChange={e => setSelectedTools(current => e.target.checked ? [...current, tool.name] : current.filter(name => name !== tool.name))} /><strong>{tool.name}</strong></label><Hint label={tool.name + ' 工具'}>{tool.description || '无说明'}<br />输入结构：{JSON.stringify(tool.inputSchema)}</Hint></div>)}
          {localPackage && tools.length > 0 && <button type="button" className="work-command justify-self-start" disabled={busy || !selectedTools.length} onClick={() => void action(async current => { const config = { connectionId: draft.localConnectionId ?? draft.id, installationId: localPackage.id, entryPoint, args: localArgs.split(/\r?\n/).filter(Boolean) }; const env = JSON.parse(localEnv) as Record<string, string>; await approveLocalMcp(mcpSessionId, config, selectedTools); if (!current()) return; const resources = selectedTools.map(toolName => { const tool = tools.find(item => item.name === toolName); if (!tool) throw new Error('请选择有效工具。'); return localMcpResource(localPackage, config, tool, localMcpInputContract(tool), env); }); try { for (const resource of resources) { if (!current()) return; await store.saveCapability(validateCapability(resource)); } } finally { await disconnectLocalMcpSession(mcpSessionId).catch(() => {}); if (current()) setMcpSessionId(crypto.randomUUID()); } if (!current()) return; setDraft(resources[0]); setNotice('已加密保存 ' + resources.length + ' 个工具；执行时将再次显示权限并按任务临时连接。'); })}>加密保存选中工具</button>}
          {localPackage && <button type="button" className="work-command text-danger justify-self-start" disabled={busy} onClick={() => void action(async current => { await removeLocalMcpPackage(localPackage.id); if (!current()) return; setPackages(items => items.filter(item => item.id !== localPackage.id)); setLocalPackage(null); setTools([]); setNotice('已移除本机 MCP 包。'); })}>移除安装包</button>}
        </div>}
        {(['inputFields', 'outputFields'] as const).map(key => <label className="work-label" key={`${draft.id}-${key}`}>{key === 'inputFields' ? '输入' : '输出'}字段契约 JSON<textarea className="work-input min-h-36 font-mono" defaultValue={JSON.stringify(draft[key], null, 2)} onBlur={e => { try { patch({ [key]: JSON.parse(e.target.value) }); } catch { setNotice('字段 JSON 无效'); } }} /></label>)}</>}
      <div className="flex flex-wrap gap-2"><button className="work-command bg-brand text-white" onClick={() => void action(async current => { const clean = preparedDraft(); await store.saveCapability(clean); if (!current()) return; setDraft(clean); setNotice('已加密保存。'); })}>保存到私有仓库</button><button className="work-command" onClick={() => void action(async current => { await store.removeCapability(draft.id); if (current()) selectResource(fresh(draft.kind)); })}>删除私有副本</button></div>
      <label className="work-label">发布范围<select className="work-input" value={scope} onChange={e => setScope(e.target.value)}><option value="">全站共有</option>{orgs.map(o => <option value={o.id} key={o.id}>{o.name}</option>)}</select></label>
      <button className="work-command justify-self-start" disabled={!user || busy || hasLocalMcp(draft)} onClick={() => void action(async current => { if (hasLocalMcp(draft)) throw new Error('本机 MCP 只能保存在私有仓库。'); const item = await publishCapability(validateCapability(draft), scope ? Number(scope) : null); if (!current()) return; const items = await listCapabilities(); if (current()) { setShared(items); setNotice(item.status === 'pending' ? '固定版本已提交审批。' : '固定版本已发布。'); } })}>提交新版本</button>
      <div><Hint label="能力版本与共享权限">绑定为固定快照。修改私有副本不改变已经保存的智能体；共享版停用或退出组织后无法继续调用。本机 MCP 仅支持私有仓库。</Hint></div>
    </fieldset>{notice && <p role="status" className="p-4 text-sm">{notice}</p>}
  </section>;
}
