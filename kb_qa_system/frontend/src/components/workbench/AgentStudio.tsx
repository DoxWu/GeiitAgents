import { useEffect, useRef, useState } from 'react';
import { Copy, Download, Plus, Save, Share2, Trash2 } from 'lucide-react';
import { useWorkbenchStore } from '@/store/workbenchStore';
import { useAuthStore } from '@/store/authStore';
import { copyPublicAgent, deletePublicAgent, listMyPublicAgents, listPublicAgents, savePublicAgent } from '@/api/agents';
import { getAccountGeneration } from '@/services/accountServer';
import { newAgent, validateAgent, type AgentDefinition, type AgentField, type AgentValueType, type PublicAgent } from '@/agents/definition';
import { useOrganizationOptions } from '@/hooks/useOrganizationOptions';
import { Hint } from './Hint';

function emptyField(index: number): AgentField { return { key: `field_${index + 1}`, label: `字段 ${index + 1}`, type: 'string', required: true, description: '' }; }

export function AgentStudio() {
  const store = useWorkbenchStore(), authenticated = useAuthStore(state => state.isAuthenticated);
  const [draft, setDraft] = useState<AgentDefinition>(newAgent);
  const [selected, setSelected] = useState('');
  const [publicAgents, setPublicAgents] = useState<PublicAgent[]>([]);
  const [mine, setMine] = useState<PublicAgent[]>([]);
  const [publishedOrganizationId, setPublishedOrganizationId] = useState('');
  const organizations = useOrganizationOptions();
  const userId = useAuthStore(state => state.user?.id);
  const epoch = useRef(0), initialized = useRef(false);
  const owned = Boolean(draft.sharedId && mine.some(item => item.id === draft.sharedId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const current = store.agents.find(item => item.id === selected);

  useEffect(() => {
    const published = mine.find(item => item.id === draft.sharedId);
    if (published) setPublishedOrganizationId(published.organizationId ? String(published.organizationId) : '');
  }, [draft.sharedId, mine]);

  useEffect(() => { const currentEpoch = epoch; currentEpoch.current++; setPublicAgents([]); setMine([]); return () => { currentEpoch.current++; }; }, [userId]);
  useEffect(() => { if (!store.unlocked) { initialized.current = false; setDraft(newAgent()); setSelected(''); epoch.current++; }
    else if (!initialized.current) { initialized.current = true; if (store.agents[0]) { setDraft(store.agents[0]); setSelected(store.agents[0].id); } }
  }, [store.agents, store.unlocked]);
  function operationGuard() { const version = epoch.current, account = getAccountGeneration(); return () => { if (version !== epoch.current || account !== getAccountGeneration()) throw new Error('账号或密钥库状态已改变，请重新操作。'); }; }
  function patch(patchValue: Partial<AgentDefinition>) { setDraft(value => ({ ...value, ...patchValue })); setError(''); setNotice(''); }
  function patchField(kind: 'inputFields' | 'outputFields', index: number, value: Partial<AgentField>) {
    patch({ [kind]: draft[kind].map((field, fieldIndex) => fieldIndex === index ? { ...field, ...value } : field) });
  }
  function addField(kind: 'inputFields' | 'outputFields') {
    if (draft[kind].length >= 10) return;
    patch({ [kind]: [...draft[kind], emptyField(draft[kind].length)] });
  }
  async function savePrivate() {
    setBusy(true); setError(''); setNotice('');
    try {
      const clean = validateAgent(draft); await store.saveAgent(clean); setDraft(clean); setSelected(clean.id); setNotice('智能体已加密保存到本机私有仓库。');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败。'); }
    finally { setBusy(false); }
  }
  async function refreshPublic() {
    const guard = operationGuard();
    setBusy(true); setError(''); setNotice('');
    try { const items = await listPublicAgents(); guard(); setPublicAgents(items); const own = await listMyPublicAgents(); guard(); setMine(own); setNotice('已更新共有智能体列表。'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '共有仓库不可用。'); }
    finally { setBusy(false); }
  }
  async function publish() {
    if (!store.unlocked || !window.confirm('将当前指令、说明及字段契约发布给所有已登录用户？请确认其中没有私有资料或凭据。')) return;
    const guard = operationGuard();
    setBusy(true); setError(''); setNotice('');
    try {
      const clean = validateAgent({ ...draft, sharedId: owned ? draft.sharedId : undefined });
      const saved = await savePublicAgent(clean, publishedOrganizationId ? Number(publishedOrganizationId) : null); guard();
      const updated = { ...clean, sharedId: saved.id };
      setMine(items => [saved, ...items.filter(item => item.id !== saved.id)]);
      await store.saveAgent(updated); guard(); setDraft(updated); setSelected(updated.id); setPublicAgents(items => [saved, ...items.filter(item => item.id !== saved.id)]); setNotice('智能体已发布到共有仓库。');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '发布失败。'); }
    finally { setBusy(false); }
  }
  async function importPublic(item: PublicAgent) {
    const copy = copyPublicAgent(item); setPublishedOrganizationId(''); setBusy(true); setError(''); setNotice('');
    try { await store.saveAgent(copy); setDraft(copy); setSelected(copy.id); setNotice('已复制到本机私有仓库，可继续编辑。'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '复制失败。'); }
    finally { setBusy(false); }
  }
  async function removePrivate() {
    if (!current) return;
    setBusy(true); setError('');
    try { await store.removeAgent(current.id); const next = store.agents.find(item => item.id !== current.id); setDraft(next ?? newAgent()); setSelected(next?.id ?? ''); setNotice('已从本机仓库删除。共有版本需在“我的公开智能体”中单独管理。'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '删除失败。'); }
    finally { setBusy(false); }
  }
  async function removePublic() {
    if (!draft.sharedId || !owned || !window.confirm('删除此共有版本？已有工作流保存的定义快照仍可使用。')) return;
    const guard = operationGuard();
    setBusy(true); setError('');
    try { await deletePublicAgent(draft.sharedId); guard(); setMine(items => items.filter(item => item.id !== draft.sharedId)); setPublicAgents(items => items.filter(item => item.id !== draft.sharedId)); const updated = { ...draft, sharedId: undefined }; await store.saveAgent(updated); guard(); setDraft(updated); setPublishedOrganizationId(''); setNotice('共有版本已删除，本机私有定义仍保留。'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '删除共有版本失败。'); }
    finally { setBusy(false); }
  }

  return <section className="grid min-h-0 flex-1 overflow-auto lg:grid-cols-[260px_minmax(0,1fr)]" aria-label="智能体编排与仓库">
    <aside className="grid content-start gap-3 border-b border-line p-4 lg:border-b-0 lg:border-r">
      <div className="flex items-center justify-between"><h2 className="text-sm font-semibold">本机私有仓库 · {store.agents.length}</h2><button className="work-icon" title="新建智能体" aria-label="新建智能体" disabled={!store.unlocked || busy} onClick={() => { const next = newAgent(); setDraft(next); setSelected(''); }}><Plus size={17} /></button></div>
      {!store.unlocked && <p className="text-sm text-ink-secondary">请解锁本机加密库后创建私有智能体。</p>}
      {store.agents.map(item => <button key={item.id} className={`w-full truncate border px-3 py-2 text-left text-sm ${selected === item.id ? 'border-brand bg-muted' : 'border-line'}`} onClick={() => { setDraft(structuredClone(item)); setSelected(item.id); }}>{item.name}{item.sharedId ? ' · 已共享' : ''}</button>)}
      <div className="mt-3 grid gap-2 border-t border-line pt-3"><div className="flex items-center justify-between"><h3 className="text-sm font-semibold">共有仓库 · {publicAgents.length}</h3><button className="work-icon" title="刷新共有仓库" aria-label="刷新共有仓库" disabled={!authenticated || busy} onClick={() => void refreshPublic()}><Download size={15} /></button></div>
        {!authenticated && <p className="text-xs text-ink-secondary">登录后查看共有智能体。</p>}
        {publicAgents.map(item => <article key={item.id} className="grid gap-1 border border-line p-2 text-xs"><strong className="truncate">{item.agent.name}</strong><span className="text-ink-secondary">{item.organizationId ? organizations.find(org => org.id === item.organizationId)?.name || '组织共享' : '全站共享'} · {item.ownerName} · {item.agent.summary || '暂无说明'}</span><button className="work-command justify-self-start" disabled={!store.unlocked || busy} onClick={() => void importPublic(item)}><Copy size={14} />复制到私有</button></article>)}
      </div>
    </aside>
    <div className="grid content-start gap-5 p-4 sm:p-6">
      <div className="flex items-center gap-1"><h1 className="text-lg font-semibold">智能体编排</h1><Hint label="智能体编排">定义任务指令与结构化输入、输出，绑定的函数、技能、MCP 会作为固定快照；工作流继续使用保存时的定义。可用工具以字段契约作为输入输出边界，运行前需检查它们的访问范围。</Hint></div>
      <label className="work-label">智能体名称<input className="work-input" maxLength={100} value={draft.name} onChange={event => patch({ name: event.target.value })} /></label>
      <label className="work-label">用途说明<input className="work-input" maxLength={300} value={draft.summary} onChange={event => patch({ summary: event.target.value })} /></label>
      <label className="work-label">系统指令<textarea className="work-input min-h-32 resize-y" maxLength={5000} value={draft.instructions} onChange={event => patch({ instructions: event.target.value })} placeholder="说明智能体的职责、处理规则和需要避免的行为" /></label>
      {(['inputFields', 'outputFields'] as const).map((kind, groupIndex) => <fieldset key={kind} className="grid gap-3 border-t border-line pt-4"><legend className="mb-2 text-sm font-semibold">{groupIndex === 0 ? '输入格式' : '输出格式'}</legend>
        {draft[kind].map((field, index) => <div key={`${kind}-${index}`} className="grid gap-2 border border-line p-3 sm:grid-cols-[1fr_1fr_140px_auto]">
          <label className="work-label">字段键<input className="work-input font-mono" maxLength={40} value={field.key} onChange={event => patchField(kind, index, { key: event.target.value })} /></label>
          <label className="work-label">显示名称<input className="work-input" maxLength={80} value={field.label} onChange={event => patchField(kind, index, { label: event.target.value })} /></label>
          <label className="work-label">类型<select className="work-input" value={field.type} onChange={event => patchField(kind, index, { type: event.target.value as AgentValueType })}><option value="string">文字</option><option value="number">数字</option><option value="boolean">布尔值</option></select></label>
          <button className="work-icon self-end" title="删除字段" aria-label="删除字段" disabled={draft[kind].length <= 1} onClick={() => patch({ [kind]: draft[kind].filter((_, fieldIndex) => fieldIndex !== index) })}><Trash2 size={15} /></button>
          <label className="work-label sm:col-span-3">字段说明<input className="work-input" maxLength={240} value={field.description} onChange={event => patchField(kind, index, { description: event.target.value })} /></label>
          <label className="flex items-center gap-2 self-center text-xs"><input type="checkbox" checked={field.required} onChange={event => patchField(kind, index, { required: event.target.checked })} />必填</label>
        </div>)}
        <button className="work-command justify-self-start" disabled={draft[kind].length >= 10} onClick={() => addField(kind)}><Plus size={14} />增加字段</button>
      </fieldset>)}
      <label className="work-label max-w-md">共有仓库发布范围<select className="work-input" value={publishedOrganizationId} onChange={event => setPublishedOrganizationId(event.target.value)} disabled={busy || !authenticated}><option value="">所有已登录用户</option>{organizations.map(org => <option key={org.id} value={org.id}>{org.name}</option>)}</select></label>
      <fieldset className="grid gap-2 border-t border-line pt-4"><legend className="flex items-center text-sm font-semibold">绑定工具、技能与 MCP · {draft.capabilities?.length ?? 0}/12<Hint label="能力仓库">私有工具可直接由当前用户使用。共有能力需经过审批并保持有效授权。本机 stdio 工具仅保存在本机私有库，不会进入共有智能体，且需要在手动任务中再次授权。</Hint></legend>
        {!store.capabilities.length && <p className="text-xs text-ink-secondary">先在资源仓库创建或导入能力。工具函数需检查代码后确认，远程 MCP 需管理员批准。</p>}
        {store.capabilities.map(resource => <label className="flex items-start gap-2 text-sm" key={resource.id}><input type="checkbox" checked={Boolean(draft.capabilities?.some(r => r.id === resource.id))} disabled={busy || !draft.capabilities?.some(r => r.id === resource.id) && (draft.capabilities?.length ?? 0) >= 12} onChange={e => patch({ capabilities: e.target.checked ? [...(draft.capabilities ?? []), structuredClone(resource)] : draft.capabilities?.filter(r => r.id !== resource.id) })} /><span>{resource.name} · {resource.kind} · v{resource.version}<small className="block text-ink-secondary">{resource.description}</small></span></label>)}
        {draft.capabilities?.filter(r => !store.capabilities.some(c => c.id === r.id)).map(r => <label className="flex gap-2 text-sm" key={r.id}><input type="checkbox" checked onChange={() => patch({ capabilities: draft.capabilities?.filter(c => c.id !== r.id) })} />{r.name} · 固定快照</label>)}
      </fieldset>
      <div className="flex flex-wrap gap-2 border-t border-line pt-4"><button className="work-command bg-brand text-white" disabled={busy || !store.unlocked} onClick={() => void savePrivate()}><Save size={15} />保存到私有仓库</button>
        <button className="work-command" disabled={busy || !authenticated || !store.unlocked} onClick={() => void publish()}><Share2 size={15} />{owned ? '更新共有版本' : '发布到共有仓库'}</button>
        {owned && <button className="work-command" disabled={busy || !authenticated || !store.unlocked} onClick={() => void removePublic()}><Trash2 size={15} />删除共有版本</button>}
        {current && <button className="work-command" disabled={busy} onClick={() => void removePrivate()}><Trash2 size={15} />删除私有副本</button>}
      </div>
      <Hint label="共有智能体说明">共有智能体仅保存字段契约和指令；每位使用者在本机选择模型连接，模型密钥不会共享。公开内容在执行前仍应由使用者审阅。</Hint>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}{notice && <p role="status" className="text-sm text-ink-secondary">{notice}</p>}
    </div>
  </section>;
}
