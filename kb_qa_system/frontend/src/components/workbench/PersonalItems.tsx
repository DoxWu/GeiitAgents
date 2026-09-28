import { useEffect, useRef, useState } from 'react';
import { Download, Plus, Save, Trash2 } from 'lucide-react';
import { useWorkbenchStore } from '@/store/workbenchStore';
import { PrivateMarkdown } from './LocalMarkdown';
import { isOverdue, localDateInput, localDateToUtc, personalMarkdown, type PersonalInput, type PersonalItem, type Priority, type TodoStatus } from '@/personal/items';

const statusLabels = { open: '待完成', done: '已完成', cancelled: '已取消' };
function blank(kind: 'note' | 'todo'): PersonalInput {
  return kind === 'note' ? { kind, title: '', content: '', tags: [] } : { kind, title: '', content: '', tags: [], dueAt: null, status: 'open', priority: 'normal' };
}
function exportItem(item: PersonalItem) {
  const url = URL.createObjectURL(new Blob([personalMarkdown(item)], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = item.title.replace(/[<>:"/\\|?*]/g, '_') + '.md'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function PersonalItems() {
  const store = useWorkbenchStore();
  const [kind, setKind] = useState<'note' | 'todo'>('todo');
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all');
  const [id, setId] = useState<string>(() => crypto.randomUUID()), [revision, setRevision] = useState(0);
  const [input, setInput] = useState<PersonalInput>(() => blank('todo'));
  const [tags, setTags] = useState(''), [due, setDue] = useState('');
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [now, setNow] = useState(Date.now);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; const timer = setInterval(() => setNow(Date.now()), 30000); return () => { mounted.current = false; clearInterval(timer); }; }, []);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const saved = store.personalItems.find(item => item.id === id);
  const search = query.trim().toLocaleLowerCase();
  const items = store.personalItems.filter(item => item.kind === kind && (!search || [item.title, item.content, ...item.tags].join('\n').toLocaleLowerCase().includes(search))
    && (kind === 'note' || filter === 'all' || (filter === 'overdue' ? isOverdue(item, now) : item.kind === 'todo' && item.status === filter)))
    .sort((a, b) => {
      if (a.kind === 'todo' && b.kind === 'todo') return Number(a.status !== 'open') - Number(b.status !== 'open') || (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity) || b.updatedAt.localeCompare(a.updatedAt);
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  function mayLeave() { return !dirty || window.confirm('放弃当前未保存的修改？'); }
  function select(item?: PersonalItem, targetKind = kind) {
    if (!mayLeave()) return;
    setKind(targetKind); setInput(item ?? blank(targetKind)); setId(item?.id ?? crypto.randomUUID()); setRevision(item?.revision ?? 0);
    setTags(item?.tags.join('，') ?? ''); setDue(item?.kind === 'todo' ? localDateInput(item.dueAt) : '');
    setDirty(false); setError(''); setNotice('');
  }
  function edit(patch: Partial<PersonalInput>) { setInput(current => ({ ...current, ...patch } as PersonalInput)); setDirty(true); setNotice(''); }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    let changedInMemory = false;
    try {
      const next = { ...input, tags: tags.split(/[,，]/) };
      if (next.kind === 'todo') next.dueAt = localDateInput(next.dueAt) === due ? next.dueAt : localDateToUtc(due);
      const before = useWorkbenchStore.getState().personalItems.find(item => item.id === id);
      const pending = store.savePersonalItem(id, next, revision);
      changedInMemory = useWorkbenchStore.getState().personalItems.find(item => item.id === id) !== before;
      const result = await pending;
      if (mounted.current) { setInput(result); setRevision(result.revision); setTags(result.tags.join('，')); setDirty(false); setNotice('已保存到本机加密库。'); }
    } catch (e) {
      if (mounted.current) {
        if (changedInMemory) setRevision(revision + 1);
        setError(e instanceof Error ? e.message : '保存失败。');
      }
    } finally { if (mounted.current) setBusy(false); }
  }
  async function remove() {
    if (!saved || !window.confirm('删除此记录？删除前可先导出 Markdown。')) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await store.removePersonalItem(saved.id, saved.revision);
      if (mounted.current) { setInput(blank(kind)); setId(crypto.randomUUID()); setRevision(0); setTags(''); setDue(''); setDirty(false); setNotice('已删除。'); }
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : '删除失败。'); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <section className="flex min-h-0 flex-1 flex-col" aria-label="笔记与待办">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-3">
      <button className={`work-command ${kind === 'todo' ? 'bg-muted' : ''}`} disabled={busy} onClick={() => select(undefined, 'todo')}>待办</button>
      <button className={`work-command ${kind === 'note' ? 'bg-muted' : ''}`} disabled={busy} onClick={() => select(undefined, 'note')}>笔记</button>
      <button className="work-command" disabled={busy} onClick={() => select()}><Plus size={16} />{kind === 'note' ? '新建笔记' : '新建待办'}</button>
    </div>
    <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="max-h-64 overflow-auto border-b border-line p-3 md:max-h-none md:border-b-0 md:border-r">
        <input aria-label="搜索笔记和待办" className="work-input" placeholder="搜索标题、内容或标签" value={query} onChange={event => setQuery(event.target.value)} />
        {kind === 'todo' && <select aria-label="待办筛选" className="work-input mt-2" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部状态</option><option value="open">待完成</option><option value="overdue">已逾期</option><option value="done">已完成</option><option value="cancelled">已取消</option></select>}
        <p className="my-3 text-xs text-ink-secondary">{items.length} 条记录</p>
        {items.map(item => <button key={item.id} disabled={busy} className={`mb-1 block w-full rounded p-2 text-left ${id === item.id ? 'bg-muted' : 'hover:bg-muted'}`} onClick={() => select(item)}>
          <span className="block truncate text-sm font-medium">{item.title}</span>
          {item.kind === 'todo' && <span className={`text-xs ${isOverdue(item, now) ? 'text-danger' : 'text-ink-secondary'}`}>{statusLabels[item.status]}{isOverdue(item, now) ? ' · 已逾期' : ''}{item.priority === 'high' ? ' · 高优先级' : ''}{item.dueAt ? ` · ${new Date(item.dueAt).toLocaleString()}` : ''}</span>}
        </button>)}
        {!items.length && <p className="text-sm text-ink-secondary">没有匹配记录</p>}
      </aside>
      <div className="min-h-0 min-w-0 overflow-auto p-4 sm:p-6"><div className="mx-auto max-w-4xl">
        <h1 className="text-xl font-semibold">{kind === 'note' ? '个人笔记' : '个人待办'}</h1>
        <p className="mt-2 text-sm text-ink-secondary">仅保存在本机加密库，不上传或调用模型。截止时间用于排序和逾期提示，尚不发送邮件或系统通知。未保存草稿离开此视图或锁定后丢弃。</p>
        {store.storageError && <button className="work-command mt-3" onClick={() => void store.retryStorage().then(() => { if (mounted.current) setNotice('内存记录已重新保存。'); }).catch(e => { if (mounted.current) setError(e instanceof Error ? e.message : '保存失败。'); })}>重试本机保存</button>}
        <form onSubmit={event => void save(event)}><fieldset disabled={busy} className="mt-5 grid min-w-0 gap-4 sm:grid-cols-2">
          <label className="work-label sm:col-span-2">标题<input required maxLength={120} className="work-input" value={input.title} onChange={event => edit({ title: event.target.value })} /></label>
          <label className="work-label sm:col-span-2">内容（Markdown）<textarea aria-label="笔记或待办内容" maxLength={20000} className="work-input min-h-48 resize-y" value={input.content} onChange={event => edit({ content: event.target.value })} /></label>
          <label className="work-label sm:col-span-2">标签（逗号分隔，最多 8 个）<input className="work-input" value={tags} maxLength={250} onChange={event => { setTags(event.target.value); setDirty(true); }} /></label>
          {input.kind === 'todo' && <>
            <label className="work-label">状态<select aria-label="状态" className="work-input" value={input.status} onChange={event => edit({ status: event.target.value as TodoStatus })}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="work-label">优先级<select aria-label="优先级" className="work-input" value={input.priority} onChange={event => edit({ priority: event.target.value as Priority })}><option value="normal">普通</option><option value="high">高</option><option value="low">低</option></select></label>
            <label className="work-label sm:col-span-2">截止时间（{timezone}，可选）<input aria-label="截止时间" type="datetime-local" className="work-input" value={due} onChange={event => { setDue(event.target.value); setDirty(true); }} /><span className="text-xs text-ink-secondary">保存后固定为对应 UTC 时刻；切换设备时区仅改变显示。夏令时重复或不存在的时间需重新选择。</span></label>
          </>}
          <div className="flex flex-wrap gap-2 sm:col-span-2"><button type="submit" className="work-command bg-brand text-white"><Save size={16} />{busy ? '保存中…' : '保存记录'}</button>
            <button type="button" className="work-command" disabled={!saved} onClick={() => saved && exportItem(saved)}><Download size={16} />导出已保存记录</button>
            <button type="button" className="work-command" disabled={!saved} onClick={() => void remove()}><Trash2 size={16} />删除记录</button></div>
        </fieldset></form>
        {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}{notice && <p role="status" className="mt-3 text-sm">{notice}</p>}
        {saved && <p className="mt-3 text-xs text-ink-secondary">修订 {saved.revision} · {new Date(saved.updatedAt).toLocaleString()} · 导出文件为明文{store.storageError ? ' · 当前内存记录尚未确认保存' : ''}</p>}
        {input.content && <details className="mt-6"><summary>预览当前内容</summary><div className="mt-3"><PrivateMarkdown content={input.content} /></div></details>}
      </div></div>
    </div>
  </section>;
}
