import { useEffect, useRef, useState } from 'react';
import { Bell, ChevronDown, ChevronUp, Pause, Play, RefreshCw, Square } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import {
  createServerReminder, dismissReminderDelivery, getPersonalCapabilities, getServerReminder, listReminderDeliveries, listServerReminders,
  retryReminderDelivery, updateServerReminder, type DeliveryStatus, type PersonalCapabilities,
  type PersonalPage, type ReminderDelivery, type ReminderRecurrence, type ServerReminder,
} from '@/api/personal';
import { ReminderEditor, type ReminderEdit, type ReminderFields } from './ReminderEditor';
import { formatReminderDate } from '@/personal/reminderTime';

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
  if (!authenticated || !user) return <section className="flex min-h-0 flex-1 flex-col" aria-label="邮件提醒"><div className="p-6"><h1 className="text-xl font-semibold">邮件提醒</h1><p className="mt-3 text-sm text-ink-secondary">请登录正式账号后使用服务端邮件提醒。提醒不会保存模型密钥，也不依赖客户端保持打开。</p></div></section>;
  // Account changes unmount drafts and invalidate responses from the old account.
  return <ReminderWorkspace key={user.id + ':' + user.email} email={user.email} />;
}

function ReminderWorkspace({ email }: { email: string }) {
  const [capabilities, setCapabilities] = useState<PersonalCapabilities | null>(null);
  const [reminders, setReminders] = useState<ServerReminder[]>([]);
  const [reminderPage, setReminderPage] = useState<PageInfo | null>(null), [reminderCursors, setReminderCursors] = useState<(number | undefined)[]>([undefined]);
  const [deliveries, setDeliveries] = useState<Record<number, ReminderDelivery[]>>({});
  const [deliveryPage, setDeliveryPage] = useState<PageInfo | null>(null), [deliveryCursors, setDeliveryCursors] = useState<(number | undefined)[]>([undefined]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [editing, setEditing] = useState<{ original: ServerReminder; resume: boolean }>();
  const [editorVersion, setEditorVersion] = useState(0), [conflict, setConflict] = useState(false);
  const [draftDirty, setDraftDirty] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const lifecycle = useRef(0), busyRef = useRef(false), mounted = useRef(false);
  const createAttempt = useRef<{ fingerprint: string; requestId: string }>();

  useEffect(() => {
    mounted.current = true; const epoch = ++lifecycle.current, token = lifecycle;
    busyRef.current = true; setBusy(true);
    void Promise.all([getPersonalCapabilities(), listServerReminders()]).then(([caps, rows]) => {
      if (mounted.current && epoch === token.current) { setCapabilities(caps); setReminders(rows.items); setReminderPage(rows); }
    }).catch(cause => { if (mounted.current && epoch === token.current) setError(messageFor(cause)); })
      .finally(() => { if (mounted.current && epoch === token.current) { busyRef.current = false; setBusy(false); } });
    return () => { mounted.current = false; token.current++; busyRef.current = false; };
  }, []);

  async function perform(action: (live: () => boolean) => Promise<void>) {
    if (!mounted.current || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    const epoch = lifecycle.current, live = () => mounted.current && epoch === lifecycle.current;
    try { await action(live); }
    catch (cause) {
      if (live()) {
        setError(messageFor(cause));
        if (cause instanceof Error && cause.message === 'revision_conflict' && editing) setConflict(true);
      }
    } finally { if (live()) { busyRef.current = false; setBusy(false); } }
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
    setEditing({ original: item, resume }); setEditorVersion(value => value + 1); setConflict(false); setDraftDirty(false); setError(''); setNotice('');
  }
  async function refresh() {
    await perform(async live => {
      const [caps, rows] = await Promise.all([getPersonalCapabilities(), listServerReminders()]);
      if (live()) { setCapabilities(caps); firstPage(rows); }
    });
  }
  async function turnReminders(direction: -1 | 1) {
    if (!reminderPage || direction === -1 && reminderCursors.length <= 1 || direction === 1 && reminderPage.next_cursor === null) return;
    const cursors = direction === 1 ? [...reminderCursors, reminderPage.next_cursor!] : reminderCursors.slice(0, -1);
    await perform(async live => {
      const page = await listServerReminders(cursors.at(-1), reminderPage.snapshot_id);
      if (live()) { setReminders(page.items); setReminderPage(page); setReminderCursors(cursors); setDeliveries({}); setDeliveryPage(null); setExpanded(null); }
    });
  }
  async function save(fields: ReminderEdit) {
    await perform(async live => {
      if (editing) {
        const updated = await updateServerReminder(editing.original.id, { revision: editing.original.revision, ...fields });
        if (live()) { replace(updated); setEditing(undefined); setConflict(false); setDraftDirty(false); setEditorVersion(value => value + 1); setNotice('提醒已修改，旧版本尚未发送的投递已取消。'); }
      } else {
        const fingerprint = JSON.stringify(fields);
        if (createAttempt.current?.fingerprint !== fingerprint) createAttempt.current = { fingerprint, requestId: crypto.randomUUID() };
        const item = await createServerReminder({ ...fields as ReminderFields, request_id: createAttempt.current.requestId });
        if (live()) {
          replace(item); createAttempt.current = undefined; setDraftDirty(false); setEditorVersion(value => value + 1); setNotice('邮件提醒已保存，客户端关闭后仍由服务端调度。');
          try { const page = await listServerReminders(); if (live()) firstPage(page); }
          catch { if (live()) setError('提醒已保存，但列表刷新失败。请刷新列表查看，不要重复创建。'); }
        }
      }
    });
  }
  async function reloadEditor() {
    if (!editing) return;
    await perform(async live => {
      const latest = await getServerReminder(editing.original.id);
      if (live()) {
        replace(latest);
        if (latest.status === 'active' || latest.status === 'paused') edit(latest, editing.resume);
        else { setEditing(undefined); setNotice('提醒已结束，如需再次提醒请新建记录。'); }
        setConflict(false);
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
        <ReminderEditor key={editorVersion} original={editing?.original} resume={editing?.resume} disabled={busy || (!editing && !capabilities?.email_reminders_enabled)} conflict={conflict} onSave={save} onDirty={() => setDraftDirty(true)} onReload={() => void reloadEditor()} onCancel={() => { if (draftDirty && !window.confirm('放弃当前未保存的提醒修改？')) return; setEditing(undefined); setConflict(false); setDraftDirty(false); setEditorVersion(value => value + 1); setError(''); }} />
      </div>
      <div><h2 className="font-semibold">已安排提醒</h2><p className="mt-2 text-xs text-ink-secondary">按创建顺序从新到旧，每页最多 20 条。刷新查看新记录；已打开的编辑草稿会保留。</p>
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
