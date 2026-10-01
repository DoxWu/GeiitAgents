import { useEffect, useRef, useState } from 'react';
import { Bell, ChevronDown, ChevronUp, Download, Pause, Play, RefreshCw, Square } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { useWorkbenchStore } from '@/store/workbenchStore';
import {
  createServerReminder, dismissReminderDelivery, exportServerReminders, getPersonalCapabilities, getServerReminder, listReminderDeliveries, listServerReminders,
  retryReminderDelivery, updateServerReminder, type DeliveryStatus, type PersonalCapabilities,
  getReminderByRequest, type ReminderFilters, type PersonalPage, type ReminderDelivery, type ReminderRecurrence, type ServerReminder,
} from '@/api/personal';
import { ReminderEditor, type ReminderEdit, type ReminderFields } from './ReminderEditor';
import { formatReminderDate } from '@/personal/reminderTime';
import { reminderOwner, reminderForm, type ReminderDraft, type ReminderForm, type ReminderAttempt } from '@/personal/reminderDraft';
import { ReminderTemplates } from './ReminderTemplates';

const recurrenceLabels: Record<ReminderRecurrence, string> = { once: '一次', daily: '每天', weekly: '每周' };
const statusLabels: Record<string, string> = { active: '运行中', paused: '已暂停', cancelled: '已取消', completed: '已结束' };
const deliveryLabels: Record<DeliveryStatus, string> = { pending: '待发送', failed: '发送失败', unknown: '结果不明', sending: '发送中', sent: '已发送', cancelled: '已取消', completed: '已完成' };
type PageInfo = Pick<PersonalPage<unknown>, 'snapshot_id' | 'next_cursor'>;
function Pager({ name, depth, count, next, busy, onPage }: { name: string; depth: number; count: number; next: number | null; busy: boolean; onPage: (direction: -1 | 1) => void }) {
  return <nav aria-label={name + '分页'} className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-secondary"><span>第 {depth} 页 · 本页 {count} 条</span><button className="work-command" disabled={busy || depth <= 1} onClick={() => onPage(-1)}>上一页{name}</button><button className="work-command" disabled={busy || next === null} onClick={() => onPage(1)}>下一页{name}</button></nav>;
}

function messageFor(error: unknown) {
  if (!(error instanceof Error)) return '操作失败，请稍后重试。';
  const messages: Record<string, string> = {
    email_reminders_disabled: '服务端邮件提醒尚未启用。',
    future_schedule_required: '提醒时间必须晚于当前时间，请编辑并选择新时间。',
    rule_change_requires_schedule: '修改重复规则或时区时，请同时选择下一次提醒时间。',
    revision_conflict: '记录已被其他窗口或调度器修改，请载入最新版本后重试。',
    reminder_closed: '提醒已结束；如需再次提醒，请新建记录。',
    delivery_in_flight_or_unknown: '存在发送中或结果不明的投递。请查看投递记录；发送中需等待结果，结果不明可确认风险后重试或人工结束本次尝试。',
    duplicate_risk_acknowledgement_required: '投递结果不明，确认可能重复发送后才能重试。',
    delivery_not_retryable: '此投递当前不能重试，请刷新查看最新状态。',
    delivery_not_dismissible: '仅结果不明的投递可以人工结束；发送中的邮件需等待结果。',
    personal_storage_unavailable: '服务端暂时无法保存，请保留草稿并稍后重试。',
    invalid_personal_request: '提醒字段无效，请检查时区、日期及内容长度。',
    reminder_export_limit_exceeded: '投递记录超过 10,000 条，请缩小筛选范围后导出。',
    reminder_export_too_large: '导出内容超过 16 MiB，请缩小筛选范围后导出。',
  };
  return messages[error.message] ?? error.message;
}

function DeliveryRow({ delivery, item, disabled, onAction }: {
  delivery: ReminderDelivery; item: ServerReminder; disabled: boolean;
  onAction: (delivery: ReminderDelivery, action: 'retry' | 'dismiss') => void;
}) {
  const unknown = delivery.status === 'unknown', dismissed = delivery.error_code === 'uncertain_delivery_dismissed';
  const retryable = item.status === 'active' && item.revision === delivery.revision && (delivery.status === 'failed' || unknown);
  function retry() {
    if (unknown && !window.confirm('服务商可能已经接受这封邮件，重试可能造成重复提醒。仍要重试吗？')) return;
    onAction(delivery, 'retry');
  }
  function dismiss() {
    if (window.confirm('邮件可能已经发送。人工结束只停止本次重试，不能撤回邮件，也不代表未发送；运行中的重复提醒将继续下一周期。确认结束本次尝试？')) onAction(delivery, 'dismiss');
  }
  return <li className="border-t border-line py-3 text-sm">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><span className="font-medium">{dismissed ? '人工结束（可能已发送）' : deliveryLabels[delivery.status]}</span><span className="text-ink-secondary">计划 {formatReminderDate(delivery.scheduled_at, item.timezone)}</span><span className="text-ink-secondary">尝试 {delivery.attempts}/{delivery.retry_limit}</span></div>
    {unknown && <p className="mt-1 text-xs text-danger">无法确认服务商是否已接受邮件。修改计划前需处理本次结果。</p>}
    {delivery.status === 'failed' && <p className="mt-1 text-xs text-danger">{delivery.attempts >= delivery.retry_limit ? '自动重试次数已用完，可手动重试。' : '满足当前提醒规则时，服务端将在退避后再次尝试。'}</p>}
    <div className="mt-2 flex flex-wrap gap-2">{retryable && <button className="work-command" disabled={disabled} onClick={retry}>{unknown ? '确认风险并重试' : '重试投递'}</button>}{unknown && <button className="work-command" disabled={disabled} onClick={dismiss}>人工结束本次尝试</button>}</div>
  </li>;
}

export function ServerReminders() {
  const authenticated = useAuthStore(state => state.isAuthenticated), user = useAuthStore(state => state.user);
  const unlocked = useWorkbenchStore(state => state.unlocked);
  if (!authenticated || !user) return <section className="flex min-h-0 flex-1 flex-col" aria-label="邮件提醒"><div className="p-6"><h1 className="text-xl font-semibold">邮件提醒</h1><p className="mt-3 text-sm text-ink-secondary">请登录正式账号后使用服务端邮件提醒。提醒不会保存模型密钥，也不依赖客户端保持打开。</p></div></section>;
  if (!unlocked) return <p className="p-6">请先解锁本机密钥库，以保护提醒草稿和提交记录。</p>;
  const owner = reminderOwner(user.id, user.email);
  // Account changes unmount forms; encrypted drafts stay scoped to their owner.
  return <ReminderWorkspace key={owner} email={user.email} owner={owner} />;
}

function ReminderWorkspace({ email, owner }: { email: string; owner: string }) {
  const draftSaving = useWorkbenchStore(state => state.reminderDraftSaving), storageError = useWorkbenchStore(state => state.storageError);
  const [draft, setDraft] = useState<ReminderDraft>(() => useWorkbenchStore.getState().reminderDrafts.find(item => item.owner === owner) || { owner, form: reminderForm(), updatedAt: new Date().toISOString() });
  const editing = draft.original ? { original: draft.original, resume: draft.form.reactivate } : undefined, conflict = Boolean(draft.conflict);
  const [filters, setFilters] = useState<ReminderFilters>({}), [filterInput, setFilterInput] = useState<ReminderFilters>({});
  const [capabilities, setCapabilities] = useState<PersonalCapabilities | null>(null);
  const [reminders, setReminders] = useState<ServerReminder[]>([]);
  const [reminderPage, setReminderPage] = useState<PageInfo | null>(null), [reminderCursors, setReminderCursors] = useState<(number | undefined)[]>([undefined]);
  const [deliveries, setDeliveries] = useState<Record<number, ReminderDelivery[]>>({});
  const [deliveryPage, setDeliveryPage] = useState<PageInfo | null>(null), [deliveryCursors, setDeliveryCursors] = useState<(number | undefined)[]>([undefined]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [editorVersion, setEditorVersion] = useState(0);
  const [draftDirty, setDraftDirty] = useState(() => Boolean(useWorkbenchStore.getState().reminderDrafts.find(item => item.owner === owner)));
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const lifecycle = useRef(0), busyRef = useRef(false), mounted = useRef(false);
  const requestController = useRef<AbortController>();
  function stage(value: ReminderDraft) {
    const next = { ...value, updatedAt: new Date().toISOString() };
    useWorkbenchStore.getState().stageReminderDraft(next); setDraft(next); setDraftDirty(true);
  }
  function changeForm(form: ReminderForm) {
    if (draft.attempt || busyRef.current) return;
    try { stage({ ...draft, form }); setError(''); } catch (cause) { setError(messageFor(cause)); }
  }
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (useWorkbenchStore.getState().reminderDraftSaving || useWorkbenchStore.getState().storageError) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, []);

  useEffect(() => {
    mounted.current = true; const epoch = ++lifecycle.current, token = lifecycle;
    const unsubscribe = useAuthStore.subscribe(auth => {
      if (!auth.isAuthenticated || !auth.user || reminderOwner(auth.user.id, auth.user.email) !== owner) requestController.current?.abort();
    });
    busyRef.current = true; setBusy(true);
    void Promise.allSettled([getPersonalCapabilities(), listServerReminders()]).then(([capsResult, rowsResult]) => {
      if (!mounted.current || epoch !== token.current) return;
      const failures: string[] = [];
      if (capsResult.status === 'fulfilled') setCapabilities(capsResult.value);
      else failures.push(`提醒能力查询失败：${messageFor(capsResult.reason)}`);
      if (rowsResult.status === 'fulfilled') { setReminders(rowsResult.value.items); setReminderPage(rowsResult.value); }
      else failures.push(`提醒列表查询失败：${messageFor(rowsResult.reason)}`);
      setError(failures.join('；'));
    })
      .finally(() => { if (mounted.current && epoch === token.current) { busyRef.current = false; setBusy(false); } });
    return () => { mounted.current = false; token.current++; busyRef.current = false; requestController.current?.abort(); unsubscribe(); };
  }, [owner]);

  async function perform(action: (live: () => boolean) => Promise<void>) {
    if (!mounted.current || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    const controller = new AbortController(); requestController.current = controller;
    const epoch = lifecycle.current, live = () => {
      const auth = useAuthStore.getState();
      return !controller.signal.aborted && mounted.current && epoch === lifecycle.current && useWorkbenchStore.getState().unlocked && auth.isAuthenticated && !!auth.user && reminderOwner(auth.user.id, auth.user.email) === owner;
    };
    try { await action(live); }
    catch (cause) {
      if (live()) {
        setError(messageFor(cause));
      }
    } finally { if (live()) { busyRef.current = false; setBusy(false); } if (requestController.current === controller) requestController.current = undefined; }
  }
  function replace(item: ServerReminder) {
    setReminders(current => current.map(value => value.id === item.id ? item : value));
    setDeliveries(current => { const next = { ...current }; delete next[item.id]; return next; });
    setExpanded(null); setDeliveryPage(null);
  }
  function firstPage(page: PersonalPage<ServerReminder>) {
    setReminders(page.items); setReminderPage(page); setReminderCursors([undefined]);
    setDeliveries({}); setDeliveryPage(null); setExpanded(null);
  }
  function edit(item: ServerReminder, resume = false) {
    if (draft.attempt) { setError('请先核查上次提交，或明确放弃待核查记录。'); return; }
    try { stage({ owner, original: item, form: reminderForm(item, resume), updatedAt: new Date().toISOString() }); setDraftDirty(false); setEditorVersion(value => value + 1); setError(''); setNotice(''); }
    catch (cause) { setError(messageFor(cause)); }
  }
  async function refresh() {
    await perform(async live => {
      const [capsResult, rowsResult] = await Promise.allSettled([getPersonalCapabilities(), listServerReminders(undefined, undefined, filters)]);
      if (!live()) return;
      const failures: string[] = [];
      if (capsResult.status === 'fulfilled') setCapabilities(capsResult.value);
      else failures.push(`提醒能力查询失败：${messageFor(capsResult.reason)}`);
      if (rowsResult.status === 'fulfilled') firstPage(rowsResult.value);
      else failures.push(`提醒列表查询失败：${messageFor(rowsResult.reason)}`);
      if (failures.length) throw new Error(failures.join('；'));
    });
  }
  async function exportReminders() {
    await perform(async live => {
      const blob = await exportServerReminders(filters, requestController.current?.signal);
      if (!live()) return;
      const metadata = JSON.parse(await blob.text()) as { truncated?: boolean };
      if (!live()) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = 'geiit-reminders.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(metadata.truncated ? '已导出最新 500 条匹配提醒及其投递记录，其余提醒未包含。请缩小筛选范围后继续导出。' : '提醒和投递记录已导出。');
    });
  }
  async function turnReminders(direction: -1 | 1) {
    if (!reminderPage || direction === -1 && reminderCursors.length <= 1 || direction === 1 && reminderPage.next_cursor === null) return;
    const cursors = direction === 1 ? [...reminderCursors, reminderPage.next_cursor!] : reminderCursors.slice(0, -1);
    await perform(async live => {
      const page = await listServerReminders(cursors.at(-1), reminderPage.snapshot_id, filters);
      if (live()) { setReminders(page.items); setReminderPage(page); setReminderCursors(cursors); setDeliveries({}); setDeliveryPage(null); setExpanded(null); }
    });
  }
  function blank() { setDraft({ owner, form: reminderForm(), updatedAt: new Date().toISOString() }); setDraftDirty(false); setEditorVersion(value => value + 1); }
  async function finish(item: ServerReminder, live: () => boolean, message: string) {
    if (!live()) return;
    replace(item); setNotice(message);
    await useWorkbenchStore.getState().removeReminderDraft(owner);
    if (!live()) return;
    blank();
    try { const page = await listServerReminders(undefined, undefined, filters); if (live()) firstPage(page); }
    catch { if (live()) setError('提醒已保存，但列表刷新失败。请刷新列表查看，不要重复创建。'); }
  }
  async function sendAttempt(attempt: ReminderAttempt, live: () => boolean) {
    try {
      const item = attempt.kind === 'create' ? await createServerReminder(attempt.payload, requestController.current?.signal) : await updateServerReminder(attempt.id, attempt.payload, requestController.current?.signal);
      await finish(item, live, attempt.kind === 'create' ? '邮件提醒已保存，客户端关闭后仍由服务端调度。' : '提醒已修改，旧版本尚未发送的投递已取消。');
    } catch (cause) {
      if (live()) {
        const code = cause instanceof Error ? cause.message : '';
        // These application errors are emitted before commit. A duplicate create
        // with the same ID is looked up before these checks by the backend.
        if (['future_schedule_required', 'invalid_personal_request', 'rule_change_requires_schedule', 'email_reminders_disabled', 'personal_record_limit', 'todo_not_open', 'account_email_required', 'reminder_closed', 'delivery_in_flight_or_unknown', 'revision_conflict'].includes(code)) {
          stage({ ...draft, attempt: undefined, conflict: code === 'revision_conflict' });
          await useWorkbenchStore.getState().flushReminderDraft();
        }
      }
      throw cause;
    }
  }
  async function save(fields: ReminderEdit) {
    if (draft.attempt) return;
    await perform(async live => {
      const attempt: ReminderAttempt = editing ? { kind: 'edit', id: editing.original.id, payload: { revision: editing.original.revision, ...fields } } : { kind: 'create', payload: { ...fields as ReminderFields, request_id: crypto.randomUUID() } };
      stage({ ...draft, attempt }); await useWorkbenchStore.getState().flushReminderDraft();
      if (live()) await sendAttempt(attempt, live);
    });
  }
  async function inspectAttempt(retry = false) {
    const attempt = draft.attempt; if (!attempt) return;
    await perform(async live => {
      if (retry) { await useWorkbenchStore.getState().flushReminderDraft(); if (live()) await sendAttempt(attempt, live); return; }
      let item: ServerReminder;
      try { item = attempt.kind === 'create' ? await getReminderByRequest(attempt.payload.request_id) : await getServerReminder(attempt.id); }
      catch (cause) { if (live() && cause instanceof Error && cause.message === 'record_not_found') { setNotice('暂未查到原提交，原请求仍可能在处理。可重试同一提交；不会生成新的创建标识。'); return; } throw cause; }
      if (!live()) return;
      if (attempt.kind === 'create') { await finish(item, live, '已找到原提交的提醒，未重复创建。'); return; }
      const matches = Object.entries(attempt.payload).every(([key, value]) => key === 'revision' || (key === 'next_run_at' ? Date.parse(item.next_run_at || '') === Date.parse(String(value)) : item[key as keyof ServerReminder] === value));
      if (item.revision > attempt.payload.revision && matches) await finish(item, live, '服务端当前内容与上次提交一致，草稿已结束核查。');
      else if (item.revision !== attempt.payload.revision) { stage({ ...draft, attempt: undefined, conflict: true }); await useWorkbenchStore.getState().flushReminderDraft(); setError('服务端版本已变化，草稿已保留。请载入最新版本后重新编辑。'); }
      else setNotice('尚未确认修改已提交。可以重试同一提交，原修订号会防止重复覆盖。');
    });
  }
  async function discardDraft() {
    if (draftDirty && !window.confirm(draft.attempt ? '上次提交可能已在服务端生效。放弃本机核查记录不会取消服务端提醒，之后新建可能重复。仍要放弃？' : '放弃当前本机提醒草稿？')) return;
    await perform(async live => { await useWorkbenchStore.getState().removeReminderDraft(owner); if (live()) { blank(); setError(''); } });
  }
  async function reloadEditor() {
    if (!editing) return;
    await perform(async live => {
      const latest = await getServerReminder(editing.original.id);
      if (live()) {
        replace(latest);
        if (latest.status === 'active' || latest.status === 'paused') edit(latest, editing.resume);
        else { await useWorkbenchStore.getState().removeReminderDraft(owner); if (live()) { blank(); setNotice('提醒已结束，如需再次提醒请新建记录。'); } }
      }
    });
  }
  async function change(item: ServerReminder, status: 'active' | 'paused' | 'cancelled') {
    if (status === 'active' && (!item.next_run_at || Date.parse(item.next_run_at) <= Date.now())) {
      if (draftDirty && !window.confirm('放弃当前未保存的提醒草稿，打开改期表单？')) return;
      edit(item, true); setNotice('原计划时间已过，请选择新时间后恢复提醒。'); return;
    }
    await perform(async live => {
      const updated = await updateServerReminder(item.id, { revision: item.revision, status });
      if (live()) { replace(updated); setNotice(status === 'paused' ? '提醒已暂停。已经开始发送的邮件无法撤回。' : status === 'cancelled' ? '提醒已取消。已经开始发送的邮件无法撤回。' : '提醒已恢复。'); }
    });
  }
  async function showDeliveries(item: ServerReminder) {
    if (expanded === item.id) { setExpanded(null); return; }
    await perform(async live => {
      const rows = await listReminderDeliveries(item.id);
      if (live()) { setDeliveries({ [item.id]: rows.items }); setDeliveryPage(rows); setDeliveryCursors([undefined]); setExpanded(item.id); }
    });
  }
  async function turnDeliveries(item: ServerReminder, direction: -1 | 1) {
    if (!deliveryPage || expanded !== item.id || direction === -1 && deliveryCursors.length <= 1 || direction === 1 && deliveryPage.next_cursor === null) return;
    const cursors = direction === 1 ? [...deliveryCursors, deliveryPage.next_cursor!] : deliveryCursors.slice(0, -1);
    await perform(async live => {
      const page = await listReminderDeliveries(item.id, cursors.at(-1), deliveryPage.snapshot_id);
      if (live()) { setDeliveries({ [item.id]: page.items }); setDeliveryPage(page); setDeliveryCursors(cursors); }
    });
  }
  async function deliveryAction(item: ServerReminder, delivery: ReminderDelivery, action: 'retry' | 'dismiss') {
    await perform(async live => {
      const updated = action === 'retry' ? await retryReminderDelivery(item.id, delivery.id, delivery.status === 'unknown') : await dismissReminderDelivery(item.id, delivery.id);
      if (!live()) return;
      setDeliveries(current => ({ ...current, [item.id]: (current[item.id] || []).map(value => value.id === updated.id ? updated : value) }));
      setNotice(action === 'dismiss' ? '已人工结束本次尝试；这不代表邮件未发送。' : '已提交重试请求。');
      const latest = await getServerReminder(item.id);
      if (live()) setReminders(current => current.map(value => value.id === item.id ? latest : value));
    });
  }
  return <section className="flex min-h-0 flex-1 flex-col" aria-label="邮件提醒">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-3"><Bell size={17} className="text-brand" /><strong>邮件提醒</strong><button aria-label="刷新邮件提醒" className="work-icon ml-auto" onClick={() => void refresh()} disabled={busy}><RefreshCw size={16} /></button></div>
    <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-6"><div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
      <div>
        <p className="mb-3 break-words text-xs text-ink-secondary">收件人固定为当前账号邮箱：{email}。时间按表单所选时区输入；本机笔记和待办不会自动上传。</p>
        {capabilities && !capabilities.email_reminders_enabled && <p className="mb-3 border border-line p-3 text-sm text-ink-secondary">邮件提醒功能当前未启用。管理员需同时开启邮件和提醒配置。</p>}
        <ReminderTemplates owner={owner} form={draft.form} disabled={busy || Boolean(draft.attempt)} onApply={changeForm} />
        <p className="mb-3 text-xs text-ink-secondary" aria-label="提醒草稿保存状态">{storageError ? '本机草稿尚未确认保存，请重试保存后再提交。' : draftSaving ? '正在保存本机草稿…' : draftDirty ? '草稿已加密保存在本机，可刷新或锁库后继续。' : '输入会自动保存为本机加密草稿；提交才会发送到服务器。'}</p>
        {(draftSaving || storageError) && <button className="work-command mb-3" disabled={busy} onClick={() => void perform(async () => { await useWorkbenchStore.getState().flushReminderDraft(); })}>保存本机草稿</button>}
        {draft.attempt && <section aria-label="待核查提交" className="mb-4 border border-line p-3 text-sm"><p>上次提交尚未确认。先核查或重试原提交，避免重复创建或覆盖；不会自动重发。</p><div className="mt-2 flex flex-wrap gap-2"><button className="work-command" disabled={busy} onClick={() => void inspectAttempt()}>核查上次提交</button><button className="work-command" disabled={busy} onClick={() => void inspectAttempt(true)}>重试同一提交</button></div></section>}
        <ReminderEditor key={editorVersion} original={editing?.original} form={draft.form} onChange={changeForm} disabled={busy || Boolean(draft.attempt) || (!editing && !capabilities?.email_reminders_enabled)} conflict={conflict} onSave={save} onReload={() => void reloadEditor()} onCancel={() => void discardDraft()} />
        {draftDirty && <button className="work-command mt-3" disabled={busy} onClick={() => void discardDraft()}>放弃本机草稿</button>}
      </div>
      <div><h2 className="font-semibold">已安排提醒</h2><p className="mt-2 text-xs text-ink-secondary">按创建顺序从新到旧，每页最多 20 条。刷新查看新记录；已打开的编辑草稿会保留。</p>
        <form className="mt-3 grid gap-2" onSubmit={event => { event.preventDefault(); void perform(async live => { const page = await listServerReminders(undefined, undefined, filterInput); if (live()) { firstPage(page); setFilters({ ...filterInput }); } }); }}><fieldset disabled={busy} className="grid min-w-0 gap-2">
          <label className="work-label">搜索提醒<input className="work-input" maxLength={200} placeholder="搜索主题或正文" value={filterInput.q || ''} onChange={event => setFilterInput({ ...filterInput, q: event.target.value })} /></label>
          <div className="grid grid-cols-2 gap-2"><label className="work-label">筛选状态<select className="work-input" value={filterInput.status || ''} onChange={event => setFilterInput({ ...filterInput, status: event.target.value as ReminderFilters['status'] || undefined })}><option value="">全部状态</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="work-label">筛选重复规则<select className="work-input" value={filterInput.recurrence || ''} onChange={event => setFilterInput({ ...filterInput, recurrence: event.target.value as ReminderFilters['recurrence'] || undefined })}><option value="">全部规则</option>{Object.entries(recurrenceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
          <div className="flex flex-wrap gap-2"><button className="work-command" type="submit">搜索 / 筛选</button><button className="work-command" type="button" disabled={busy} onClick={() => void exportReminders()}><Download size={15} />导出当前筛选</button></div>
        </fieldset></form>
        {(filters.q || filters.status || filters.recurrence) && <p className="mt-2 text-xs">当前结果：{filters.q || '全部主题'} · {filters.status ? statusLabels[filters.status] : '全部状态'} · {filters.recurrence ? recurrenceLabels[filters.recurrence] : '全部规则'}</p>}
        {reminderPage && <Pager name="提醒" depth={reminderCursors.length} count={reminders.length} next={reminderPage.next_cursor} busy={busy} onPage={direction => void turnReminders(direction)} />}
        {!reminders.length && <p className="mt-4 text-sm text-ink-secondary">{busy ? '正在读取提醒…' : reminderCursors.length > 1 ? '本页已无记录，可返回上一页或刷新。' : '还没有服务端提醒。'}</p>}
        <div className="mt-3 grid gap-3">{reminders.map(item => <article aria-label={'提醒：' + item.subject} key={item.id} className="min-w-0 border border-line p-4">
          <div className="flex flex-wrap items-start gap-2"><div className="min-w-0 flex-1"><h3 className="break-words font-medium">{item.subject}</h3><p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink-secondary">{item.body.slice(0, 500)}</p>{item.body.length > 500 && <details className="mt-2 text-sm"><summary className="cursor-pointer">展开其余内容</summary><p className="mt-2 whitespace-pre-wrap break-words">{item.body.slice(500)}</p></details>}</div><span className="shrink-0 text-xs text-ink-secondary">{statusLabels[item.status]}</span></div>
          <div className="mt-3 grid gap-1 break-words text-xs text-ink-secondary"><span>{recurrenceLabels[item.recurrence]} · {formatReminderDate(item.next_run_at, item.timezone)}</span><span>时区：{item.timezone}</span><span>收件人：{item.recipient}</span></div>
          <div className="mt-3 flex flex-wrap gap-2">
            {(item.status === 'active' || item.status === 'paused') && <button className="work-command" disabled={busy} onClick={() => { if (draftDirty && !window.confirm('放弃当前未保存的提醒草稿，编辑所选提醒？')) return; edit(item); }}>编辑 / 改期</button>}
            {item.status === 'active' && <button className="work-command" disabled={busy || !!editing} onClick={() => void change(item, 'paused')}><Pause size={15} />暂停</button>}
            {item.status === 'paused' && <button className="work-command" disabled={busy || !!editing} onClick={() => void change(item, 'active')}><Play size={15} />恢复</button>}
            {(item.status === 'active' || item.status === 'paused') && <button className="work-command" disabled={busy || !!editing} onClick={() => void change(item, 'cancelled')}><Square size={15} />取消</button>}
            <button className="work-command" disabled={busy} onClick={() => void showDeliveries(item)}>{expanded === item.id ? <ChevronUp size={15} /> : <ChevronDown size={15} />}投递记录</button>
          </div>
          {expanded === item.id && <div className="mt-3"><p className="text-xs text-ink-secondary">按投递记录创建顺序从新到旧；重新打开可查看新记录。</p>{deliveryPage && <Pager name="投递" depth={deliveryCursors.length} count={(deliveries[item.id] || []).length} next={deliveryPage.next_cursor} busy={busy} onPage={direction => void turnDeliveries(item, direction)} />}<ul aria-label={'投递记录：' + item.subject} className="mt-3">{(deliveries[item.id] || []).length ? deliveries[item.id].map(delivery => <DeliveryRow key={delivery.id} delivery={delivery} item={item} disabled={busy || !!editing} onAction={(row, action) => void deliveryAction(item, row, action)} />) : <li className="border-t border-line pt-3 text-sm text-ink-secondary">暂无投递记录。</li>}</ul></div>}
        </article>)}</div>
      </div>
      {error && <p role="alert" className="break-words text-sm text-danger lg:col-span-2">{error}</p>}{notice && <p role="status" className="break-words text-sm lg:col-span-2">{notice}</p>}
    </div></div>
  </section>;
}
