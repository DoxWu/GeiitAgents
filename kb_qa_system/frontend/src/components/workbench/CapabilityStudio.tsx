import { useEffect, useState } from 'react';
import { useWorkbenchStore } from '@/store/workbenchStore';
import { useAuthStore } from '@/store/authStore';
import { useOrganizationOptions } from '@/hooks/useOrganizationOptions';
import { newFunction } from '@/workflows/functions';
import { newWorkflowNode } from '@/workflows/definition';
import { validateCapability, type CapabilityResource } from '@/agents/capabilities';
import { disableCapability, listCapabilities, publishCapability, reviewCapability, type SharedCapability } from '@/api/capabilities';
import { FunctionNodeFields } from './FunctionNodeFields';
import { useWorkbenchFence } from '@/hooks/useWorkbenchFence';

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
  useEffect(() => { setShared([]); if (!store.unlocked) setDraft(fresh('tool')); }, [user?.id, store.unlocked]);
  function patch(value: Partial<CapabilityResource>) { setDraft(d => ({ ...d, ...value, sharedId: undefined })); }
  async function action(operation: (current: () => boolean) => Promise<void>) {
    const current = capture();
    setBusy(true); setNotice(''); try { await operation(current); } catch (e) { if (current()) setNotice(e instanceof Error ? e.message : '操作失败'); } finally { setBusy(false); }
  }
  return <section className="grid min-h-0 flex-1 overflow-auto lg:grid-cols-[260px_minmax(0,1fr)]" aria-label="资源仓库">
    <aside className="grid content-start gap-2 border-r border-line p-4"><h2 className="text-sm font-semibold">工具 / 技能 / MCP</h2>
      <div className="flex flex-wrap gap-1">{(['tool', 'skill', 'mcp'] as const).map(kind => <button key={kind} className="work-command" onClick={() => setDraft(fresh(kind))}>新建{kind === 'tool' ? '工具' : kind === 'skill' ? '技能' : 'MCP'}</button>)}</div>
      {store.capabilities.map(r => <button className="work-command text-left" key={r.id} onClick={() => setDraft(structuredClone(r))}>{r.name} · v{r.version} · {r.kind}</button>)}
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
      {draft.kind === 'mcp' && <><p className="text-sm text-ink-secondary">远程 HTTPS MCP，固定工具白名单；发布并经管理员审核后可调用。支持 Streamable HTTP JSON / SSE，不运行本机命令，不保存连接密钥。调用时将发送映射输入到此服务。</p>
        <label className="work-label">MCP 地址<input className="work-input" value={draft.endpoint} onChange={e => patch({ endpoint: e.target.value })} /></label><label className="work-label">允许调用的工具<input className="work-input" value={draft.toolName} onChange={e => patch({ toolName: e.target.value })} /></label>
        {(['inputFields', 'outputFields'] as const).map(key => <label className="work-label" key={`${draft.id}-${key}`}>{key === 'inputFields' ? '输入' : '输出'}字段契约 JSON<textarea className="work-input min-h-36 font-mono" defaultValue={JSON.stringify(draft[key], null, 2)} onBlur={e => { try { patch({ [key]: JSON.parse(e.target.value) }); } catch { setNotice('字段 JSON 无效'); } }} /></label>)}</>}
      <div className="flex flex-wrap gap-2"><button className="work-command bg-brand text-white" onClick={() => void action(async () => { await store.saveCapability(validateCapability(draft)); setNotice('已加密保存。'); })}>保存到私有仓库</button><button className="work-command" onClick={() => void action(async () => { await store.removeCapability(draft.id); setDraft(fresh(draft.kind)); })}>删除私有副本</button></div>
      <label className="work-label">发布范围<select className="work-input" value={scope} onChange={e => setScope(e.target.value)}><option value="">全站共有</option>{orgs.map(o => <option value={o.id} key={o.id}>{o.name}</option>)}</select></label>
      <button className="work-command justify-self-start" disabled={!user || busy} onClick={() => void action(async current => { const item = await publishCapability(validateCapability(draft), scope ? Number(scope) : null); if (!current()) return; const items = await listCapabilities(); if (current()) { setShared(items); setNotice(item.status === 'pending' ? '固定版本已提交审批。' : '固定版本已发布。'); } })}>提交新版本</button>
      <p className="text-xs text-ink-secondary">绑定为固定快照。修改私有副本不改变已经保存的智能体；共享版停用或退出组织后无法继续调用。</p>
    </fieldset>{notice && <p role="status" className="p-4 text-sm">{notice}</p>}
  </section>;
}
