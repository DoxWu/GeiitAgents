import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Bell, Plus } from 'lucide-react';
import { useWorkbenchStore } from '@/store/workbenchStore';
import { PrivateMarkdown } from './LocalMarkdown';
import { exportPersonalItems, isOverdue, personalMarkdown, selectedPersonalItems, type PersonalInput, type PersonalItem, type PersonalSelection, type Priority, type TodoStatus } from '@/personal/items';
import { personalDraft, type PersonalDraft } from '@/personal/itemDraft';
import { ServerReminders } from './ServerReminders';
const PersonalImport = lazy(() => import('./PersonalImport').then(module => ({ default: module.PersonalImport })));

const statusLabels = { open: '待完成', done: '已完成', cancelled: '已取消' };
function download(content: string, name: string, type = 'text/markdown;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name.replace(/[<>:"/\\|?*]/g, '_'); link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function PersonalItems() {
  const [view, setView] = useState<'local' | 'reminders' | 'import'>('local');
  if (view === 'import') return <Suspense fallback={<p className="p-6">正在加载本机导入…</p>}><PersonalImport onBack={() => setView('local')} /></Suspense>;
  if (view === 'reminders') return <div className="flex min-h-0 flex-1 flex-col"><div className="flex shrink-0 gap-2 border-b border-line px-4 py-3"><button className="work-command" onClick={() => setView('local')}>本机记录</button><button className="work-command bg-muted" onClick={() => setView('reminders')}><Bell size={16} />邮件提醒</button></div><ServerReminders /></div>;
  return <LocalPersonalItems onOpenReminders={() => setView('reminders')} onOpenImport={() => setView('import')} />;
}
function LocalPersonalItems({ onOpenReminders, onOpenImport }: { onOpenReminders: () => void; onOpenImport: () => void }) {
  const store = useWorkbenchStore();
  const [draft, setDraft] = useState<PersonalDraft>(() => structuredClone(store.personalDrafts[0] ?? personalDraft()));
  const [kind, setKind] = useState<'note' | 'todo'>(draft.input.kind);
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all'), [archiveView, setArchiveView] = useState('active');
  const [selection, setSelection] = useState<PersonalSelection[]>([]);
  const [unstaged, setUnstaged] = useState(false), unstagedRef = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [now, setNow] = useState(Date.now);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const timer = setInterval(() => setNow(Date.now()), 30000);
    const warn = (event: BeforeUnloadEvent) => { const state = useWorkbenchStore.getState(); if (unstagedRef.current || state.personalDraftSaving || state.storageError) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => { mounted.current = false; clearInterval(timer); window.removeEventListener('beforeunload', warn); const state = useWorkbenchStore.getState(); if (state.unlocked && state.personalDraftSaving) void state.flushPersonalDrafts().catch(() => {}); };
  }, []);
  const saved = store.personalItems.find(item => item.id === draft.id), input = draft.input;
  const dirty = unstaged || store.personalDrafts.some(item => item.id === draft.id);
  const draftCapacityReached = store.personalDrafts.length >= 100 && !store.personalDrafts.some(item => item.id === draft.id);
  const conflict = dirty && (saved?.revision ?? 0) !== draft.baseRevision;
  const search = query.trim().toLocaleLowerCase();
  const items = store.personalItems.filter(item => item.kind === kind && (archiveView === 'all' || !!item.archivedAt === (archiveView === 'archived'))
    && (!search || [item.title, item.content, ...item.tags].join('\n').toLocaleLowerCase().includes(search))
    && (kind === 'note' || filter === 'all' || (filter === 'overdue' ? isOverdue(item, now) : item.kind === 'todo' && item.status === filter)))
    .sort((a, b) => a.kind === 'todo' && b.kind === 'todo' ? Number(a.status !== 'open') - Number(b.status !== 'open') || (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity) || b.updatedAt.localeCompare(a.updatedAt) : b.updatedAt.localeCompare(a.updatedAt));
  const drafts = store.personalDrafts.filter(item => item.input.kind === kind);
  function mayLeave() { return !unstaged || window.confirm('当前编辑尚未写入草稿，请先导出。仍要放弃当前编辑并切换？'); }
  function display(value: PersonalDraft) { setDraft(structuredClone(value)); setKind(value.input.kind); setUnstaged(false); unstagedRef.current = false; setError(''); setNotice(''); }
  function select(item?: PersonalItem, targetKind = kind) { if (!mayLeave()) return; if (targetKind !== kind) setSelection([]); display(item ? store.personalDrafts.find(draft => draft.id === item.id) ?? personalDraft(item) : personalDraft(undefined, targetKind)); }
  function tab(targetKind: 'note' | 'todo') { if (!mayLeave()) return; setSelection([]); display(store.personalDrafts.find(draft => draft.input.kind === targetKind) ?? personalDraft(undefined, targetKind)); }
  function edit(patch: Partial<PersonalInput> = {}, fields: Partial<Pick<PersonalDraft, 'tagsText' | 'dueText'>> = {}) {
    const next = { ...draft, ...fields, input: { ...input, ...patch } as PersonalInput, editId: crypto.randomUUID(), updatedAt: new Date().toISOString() };
    setDraft(next); setNotice(''); setError('');
    try { store.stagePersonalDraft(next); setUnstaged(false); unstagedRef.current = false; }
    catch (e) { setUnstaged(true); unstagedRef.current = true; setError(e instanceof Error ? e.message : '草稿保存失败，请导出当前编辑。'); }
  }
  async function action(operation: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await operation(); } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : '操作失败，请保留草稿。'); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); await action(async () => {
      const before = useWorkbenchStore.getState().personalItems.find(item => item.id === draft.id);
      try {
        store.stagePersonalDraft(draft); const result = await store.commitPersonalDraft(draft.id, draft.editId);
        if (mounted.current) { display(personalDraft(result)); setSelection([]); setNotice('已保存到本机加密库。'); }
      } catch (e) {
        // Retain an in-memory commit after a failed final write. Retry storage,
        // rather than create another record; the previous raw draft is on disk.
        const after = useWorkbenchStore.getState().personalItems.find(item => item.id === draft.id);
        if (mounted.current && after && after !== before) { display(personalDraft(after)); setSelection([]); }
        throw e;
      }
    });
  }
  async function discard() {
    if (!window.confirm('丢弃当前草稿并载入已保存记录？此操作不会删除已保存记录。')) return;
    await action(async () => { const current = useWorkbenchStore.getState().personalDrafts.find(item => item.id === draft.id); if (current) await store.discardPersonalDraft(current.id, current.editId); if (mounted.current) display(personalDraft(useWorkbenchStore.getState().personalItems.find(item => item.id === draft.id), kind)); });
  }
  async function saveAsNew() {
    await action(async () => {
      const next = { ...draft, id: crypto.randomUUID(), editId: crypto.randomUUID(), baseRevision: 0, updatedAt: new Date().toISOString() };
      store.stagePersonalDraft(next); if (mounted.current) display(next);
      await store.flushPersonalDrafts();
      if (mounted.current) setNotice('已复制为新草稿。原草稿仍保留，确认保存后可自行丢弃。');
    });
  }
  async function remove() {
    if (!saved || !window.confirm('删除此已保存记录？可先导出；未保存草稿会保留，可另存为新记录。')) return;
    await action(async () => { await store.removePersonalItem(saved.id, saved.revision); if (mounted.current) { setSelection([]); if (!dirty) display(personalDraft(undefined, kind)); setNotice('已删除。'); } });
  }
  async function archive(references: PersonalSelection[], archived: boolean) {
    await action(async () => {
      try { await store.archivePersonalItems(references, archived); }
      finally {
        // Archiving also retains an in-memory result if persistence fails. Keep
        // the editor's base revision aligned so retry does not create a conflict.
        const item = useWorkbenchStore.getState().personalItems.find(item => item.id === draft.id);
        if (mounted.current && item && !dirty && item.revision !== draft.baseRevision) { display(personalDraft(item)); setSelection([]); }
      }
      if (mounted.current) { setSelection([]); setNotice(archived ? '所选记录已归档。' : '所选记录已恢复。'); }
    });
  }
  function exportSelected(format: 'markdown' | 'json') {
    setError(''); try { const chosen = selectedPersonalItems(store.personalItems, selection); download(exportPersonalItems(chosen, format), '笔记待办-' + new Date().toISOString().slice(0, 10) + (format === 'json' ? '.json' : '.md'), format === 'json' ? 'application/json;charset=utf-8' : undefined); }
    catch (e) { setError(e instanceof Error ? e.message : '导出失败。'); }
  }
  return <section className="flex min-h-0 flex-1 flex-col" aria-label="笔记与待办">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-3">
      <button className="work-command" disabled={busy} onClick={() => { if (mayLeave()) onOpenImport(); }}>导入 JSON</button>
      <button className={`work-command ${kind === 'todo' ? 'bg-muted' : ''}`} disabled={busy} onClick={() => tab('todo')}>待办</button>
      <button className={`work-command ${kind === 'note' ? 'bg-muted' : ''}`} disabled={busy} onClick={() => tab('note')}>笔记</button>
      <button className="work-command" disabled={busy} onClick={() => select()}><Plus size={16} />{kind === 'note' ? '新建笔记' : '新建待办'}</button>
      <button className="work-command ml-auto" disabled={busy} onClick={() => { if (mayLeave()) onOpenReminders(); }}><Bell size={16} />邮件提醒</button>
    </div>
    <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="max-h-80 overflow-auto border-b border-line p-3 md:max-h-none md:border-b-0 md:border-r">
        <input aria-label="搜索笔记和待办" className="work-input" placeholder="搜索标题、内容或标签" value={query} onChange={event => { setQuery(event.target.value); setSelection([]); }} />
        <select aria-label="归档筛选" className="work-input mt-2" value={archiveView} onChange={event => { setArchiveView(event.target.value); setSelection([]); }}><option value="active">未归档</option><option value="archived">已归档</option><option value="all">全部记录</option></select>
        {kind === 'todo' && <select aria-label="待办筛选" className="work-input mt-2" value={filter} onChange={event => { setFilter(event.target.value); setSelection([]); }}><option value="all">全部状态</option><option value="open">待完成</option><option value="overdue">已逾期</option><option value="done">已完成</option><option value="cancelled">已取消</option></select>}
        {!!drafts.length && <section aria-label="本机编辑草稿" className="my-3 border-b border-line pb-3"><h2 className="text-sm font-medium">编辑草稿（{drafts.length}）</h2>{drafts.map(value => <button key={value.id} className="work-command mt-2 w-full text-left" disabled={busy} onClick={() => { if (mayLeave()) display(value); }} aria-label={'恢复草稿：' + (value.input.title || '未命名')}><span className="truncate">{value.input.title || '未命名草稿'}</span></button>)}</section>}
        <p className="my-3 text-xs text-ink-secondary">{items.length} 条记录 · 已选 {selection.length} 条</p>
        <fieldset disabled={busy} className="mb-3 flex flex-wrap gap-2">
          <button className="work-command" disabled={!items.length} onClick={() => setSelection(items.map(({ id, revision }) => ({ id, revision })))}>选中筛选结果</button><button className="work-command" disabled={!selection.length} onClick={() => setSelection([])}>清空选择</button>
          <button className="work-command" disabled={!selection.length} onClick={() => exportSelected('markdown')}>批量导出 Markdown</button><button className="work-command" disabled={!selection.length} onClick={() => exportSelected('json')}>批量导出 JSON</button>
          <button className="work-command" disabled={!selection.length || !!store.storageError} onClick={() => void archive(selection, true)}>归档所选</button><button className="work-command" disabled={!selection.length || !!store.storageError} onClick={() => void archive(selection, false)}>恢复所选</button>
        </fieldset>
        {items.map(item => <div className={`mb-1 flex items-start gap-2 rounded p-2 ${draft.id === item.id ? 'bg-muted' : 'hover:bg-muted'}`} key={item.id}>
          <input type="checkbox" className="mt-1" aria-label={'选择记录：' + item.title} disabled={busy} checked={selection.some(value => value.id === item.id)} onChange={event => setSelection(current => event.target.checked ? [...current, { id: item.id, revision: item.revision }] : current.filter(value => value.id !== item.id))} />
          <button disabled={busy} className="min-w-0 flex-1 text-left" onClick={() => select(item)}><span className="block truncate text-sm font-medium">{item.title}</span>{item.archivedAt && <span className="text-xs text-ink-secondary">已归档 · </span>}
            {item.kind === 'todo' && <span className={`text-xs ${isOverdue(item, now) ? 'text-danger' : 'text-ink-secondary'}`}>{statusLabels[item.status]}{isOverdue(item, now) ? ' · 已逾期' : ''}{item.priority === 'high' ? ' · 高优先级' : ''}{item.dueAt ? ` · ${new Date(item.dueAt).toLocaleString()}` : ''}</span>}
          </button>
        </div>)}
        {!items.length && <p className="text-sm text-ink-secondary">没有匹配记录</p>}
      </aside>
      <div className="min-h-0 min-w-0 overflow-auto p-4 sm:p-6"><div className="mx-auto max-w-4xl">
        <h1 className="text-xl font-semibold">{kind === 'note' ? '个人笔记' : '个人待办'}</h1>
        <p className="mt-2 text-sm text-ink-secondary">记录和编辑草稿仅保存在本机加密库，不上传或调用模型。截止时间用于排序和逾期提示；归档不会取消独立创建的邮件提醒。所有导出文件均为明文。</p>
        <p className="mt-3 text-xs text-ink-secondary" aria-label="本机编辑草稿保存状态">{unstaged ? '当前编辑尚未进入草稿，请重试或导出后再离开。' : store.storageError ? '本机修改尚未确认保存，请重试本机保存。' : store.personalDraftSaving ? '正在加密保存草稿…' : dirty ? '草稿已加密保存，切换记录、刷新或锁库后可继续。' : '输入后自动保存为独立草稿；保存记录才会更新正式内容。'}</p>
        {(store.storageError || store.personalDraftSaving || unstaged) && <button className="work-command mt-3" disabled={busy} onClick={() => void action(async () => { if (unstaged) { store.stagePersonalDraft(draft); setUnstaged(false); unstagedRef.current = false; } await store.flushPersonalDrafts(); if (mounted.current) setNotice('本机记录和草稿已重新保存。'); })}>重试本机保存</button>}
        {conflict && <p role="alert" className="mt-3 text-sm text-danger">已保存记录已改变或被删除。当前草稿仍保留，请载入最新记录或另存为新记录。</p>}
        {saved?.archivedAt && <p className="mt-3 text-sm">此记录已归档，恢复后才能修改。</p>}
        {draftCapacityReached && <p role="alert" className="mt-3 text-sm text-danger">已达到 100 条草稿上限。请先保存或丢弃已有草稿，再开始新的编辑。</p>}
        <form onSubmit={event => void save(event)}><fieldset disabled={busy || !!saved?.archivedAt || draftCapacityReached} className="mt-5 grid min-w-0 gap-4 sm:grid-cols-2">
          <label className="work-label sm:col-span-2">标题<input required maxLength={120} className="work-input" value={input.title} onChange={event => edit({ title: event.target.value })} /></label>
          <label className="work-label sm:col-span-2">内容（Markdown）<textarea aria-label="笔记或待办内容" maxLength={20000} className="work-input min-h-48 resize-y" value={input.content} onChange={event => edit({ content: event.target.value })} /></label>
          <label className="work-label sm:col-span-2">标签（逗号分隔，最多 8 个）<input className="work-input" value={draft.tagsText} maxLength={250} onChange={event => edit({}, { tagsText: event.target.value })} /></label>
          {input.kind === 'todo' && <>
            <label className="work-label">状态<select aria-label="状态" className="work-input" value={input.status} onChange={event => edit({ status: event.target.value as TodoStatus })}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="work-label">优先级<select aria-label="优先级" className="work-input" value={input.priority} onChange={event => edit({ priority: event.target.value as Priority })}><option value="normal">普通</option><option value="high">高</option><option value="low">低</option></select></label>
            <label className="work-label sm:col-span-2">截止时间（{draft.timezone}，可选）<input aria-label="截止时间" type="datetime-local" className="work-input" value={draft.dueText} onChange={event => edit({}, { dueText: event.target.value })} /><span className="text-xs text-ink-secondary">使用此草稿的固定时区；新截止时间须在 1970–2100 年内。夏令时重复或不存在的时间需重新选择。</span></label>
          </>}
          <button type="submit" className="work-command bg-brand text-white sm:col-span-2 justify-self-start" disabled={conflict || !!store.storageError}>{busy ? '保存中…' : '保存记录'}</button>
        </fieldset></form>
        <fieldset disabled={busy} className="mt-3 flex flex-wrap gap-2">
          <button className="work-command" disabled={!saved} onClick={() => saved && download(personalMarkdown(saved), saved.title + '.md')}>导出已保存记录</button>
          <button className="work-command" disabled={!saved || dirty || !!store.storageError} onClick={() => saved && void archive([{ id: saved.id, revision: saved.revision }], !saved.archivedAt)}>{saved?.archivedAt ? '恢复记录' : '归档记录'}</button>
          <button className="work-command" disabled={!saved || !!store.storageError} onClick={() => void remove()}>删除记录</button>
          {dirty && <><button className="work-command" onClick={() => void discard()}>丢弃草稿并载入最新记录</button><button className="work-command" onClick={() => void saveAsNew()}>另存为新草稿</button><button className="work-command" onClick={() => download(JSON.stringify(draft, null, 2), '编辑草稿.json', 'application/json;charset=utf-8')}>导出当前草稿</button></>}
        </fieldset>
        {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}{notice && <p role="status" className="mt-3 text-sm">{notice}</p>}
        {saved && <p className="mt-3 text-xs text-ink-secondary">修订 {saved.revision} · {new Date(saved.updatedAt).toLocaleString()}{store.storageError ? ' · 当前内存记录尚未确认保存' : ''}</p>}
        {input.content && <details className="mt-6"><summary>预览当前内容</summary><div className="mt-3"><PrivateMarkdown content={input.content} /></div></details>}
      </div></div>
    </div>
  </section>;
}
