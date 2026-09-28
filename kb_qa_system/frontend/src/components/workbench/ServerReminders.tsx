import { useEffect, useMemo, useState } from "react";
import { Bell, ChevronDown, ChevronUp, Pause, Play, RefreshCw, RotateCcw, Square } from "lucide-react";
import { useAuthStore } from "@/store/authStore";
import {
  createServerReminder, getPersonalCapabilities, listReminderDeliveries, listServerReminders,
  retryReminderDelivery, updateServerReminder, type DeliveryStatus, type PersonalCapabilities,
  type ReminderDelivery, type ReminderRecurrence, type ServerReminder,
} from "@/api/personal";

const recurrenceLabels: Record<ReminderRecurrence, string> = { once: "一次", daily: "每天", weekly: "每周" };
const statusLabels: Record<string, string> = { active: "运行中", paused: "已暂停", cancelled: "已取消", completed: "已完成" };
const deliveryLabels: Record<DeliveryStatus, string> = { pending: "待发送", failed: "发送失败", unknown: "结果不明", sending: "发送中", sent: "已发送", cancelled: "已取消", completed: "已完成" };

function localDateTime(hours = 1) {
  const date = new Date(Date.now() + hours * 3600000), pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toUtc(value: string) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) throw new Error("提醒时间必须晚于当前时间。");
  return date.toISOString();
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : "未安排";
}

function messageFor(error: unknown) {
  if (!(error instanceof Error)) return "操作失败，请稍后重试。";
  const messages: Record<string, string> = {
    email_reminders_disabled: "服务端邮件提醒尚未启用。",
    future_schedule_required: "提醒时间必须晚于当前时间。",
    revision_conflict: "记录已被其他窗口修改，请刷新后重试。",
    duplicate_risk_acknowledgement_required: "投递结果不明，确认可能重复发送后才能重试。",
    delivery_not_retryable: "此投递当前不能重试。",
  };
  return messages[error.message] ?? error.message;
}

function DeliveryRow({ delivery, onRetry }: { delivery: ReminderDelivery; onRetry: (delivery: ReminderDelivery, acknowledge: boolean) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  async function retry(acknowledge: boolean) {
    if (acknowledge && !window.confirm("服务商可能已经接受这封邮件，重试可能造成重复提醒。仍要重试吗？")) return;
    setBusy(true);
    try { await onRetry(delivery, acknowledge); } finally { setBusy(false); }
  }
  const unknown = delivery.status === "unknown";
  return <li className="border-t border-line py-3 text-sm">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><span className="font-medium">{deliveryLabels[delivery.status]}</span><span className="text-ink-secondary">计划 {formatDate(delivery.scheduled_at)}</span><span className="text-ink-secondary">尝试 {delivery.attempts}/{delivery.retry_limit}</span></div>
    {delivery.error_code && <p className="mt-1 text-xs text-danger">{delivery.error_code === "delivery_outcome_unknown" ? "服务中断时无法确认服务商是否已接受邮件。" : "服务端将在退避后再次尝试。"}</p>}
    {(delivery.status === "failed" || unknown) && <button className="work-command mt-2" disabled={busy} onClick={() => void retry(unknown)}>{unknown ? <RotateCcw size={15} /> : <RefreshCw size={15} />}{unknown ? "确认风险并重试" : "重试投递"}</button>}
  </li>;
}

export function ServerReminders() {
  const authenticated = useAuthStore((state) => state.isAuthenticated);
  const user = useAuthStore((state) => state.user);
  const [capabilities, setCapabilities] = useState<PersonalCapabilities | null>(null);
  const [reminders, setReminders] = useState<ServerReminder[]>([]);
  const [deliveries, setDeliveries] = useState<Record<number, ReminderDelivery[]>>({});
  const [expanded, setExpanded] = useState<number | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [nextRun, setNextRun] = useState(() => localDateTime());
  const [recurrence, setRecurrence] = useState<ReminderRecurrence>("once");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  async function refresh() {
    setError("");
    try {
      const [nextCapabilities, nextReminders] = await Promise.all([getPersonalCapabilities(), listServerReminders()]);
      setCapabilities(nextCapabilities); setReminders(nextReminders);
    } catch (cause) { setError(messageFor(cause)); }
  }
  useEffect(() => { if (authenticated) void refresh(); else { setCapabilities(null); setReminders([]); } }, [authenticated]);

  const canCreate = Boolean(authenticated && capabilities?.email_reminders_enabled && subject.trim() && body.trim());
  const sorted = useMemo(() => [...reminders].sort((a, b) => (a.next_run_at ?? "9999").localeCompare(b.next_run_at ?? "9999")), [reminders]);

  async function create(event: React.FormEvent) {
    event.preventDefault(); if (!canCreate) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const item = await createServerReminder({ request_id: crypto.randomUUID(), subject: subject.trim(), body: body.trim(), timezone, recurrence, next_run_at: toUtc(nextRun) });
      setReminders((current) => [item, ...current]); setSubject(""); setBody(""); setNextRun(localDateTime()); setNotice("邮件提醒已保存，客户端关闭后仍由服务端调度。");
    } catch (cause) { setError(messageFor(cause)); } finally { setBusy(false); }
  }
  async function change(item: ServerReminder, status: "active" | "paused" | "cancelled") {
    setBusy(true); setError(""); setNotice("");
    try { const updated = await updateServerReminder(item.id, { revision: item.revision, status }); setReminders((current) => current.map(value => value.id === item.id ? updated : value)); setNotice(status === "paused" ? "提醒已暂停。" : status === "cancelled" ? "提醒已取消。" : "提醒已恢复。"); }
    catch (cause) { setError(messageFor(cause)); } finally { setBusy(false); }
  }
  async function showDeliveries(item: ServerReminder) {
    if (expanded === item.id) { setExpanded(null); return; }
    setExpanded(item.id); setBusy(true); setError("");
    try { const rows = await listReminderDeliveries(item.id); setDeliveries((current) => ({ ...current, [item.id]: rows })); } catch (cause) { setError(messageFor(cause)); } finally { setBusy(false); }
  }
  async function retry(item: ServerReminder, delivery: ReminderDelivery, acknowledge: boolean) {
    const updated = await retryReminderDelivery(item.id, delivery.id, acknowledge);
    setDeliveries((current) => ({ ...current, [item.id]: (current[item.id] ?? []).map(value => value.id === updated.id ? updated : value) }));
  }

  if (!authenticated) return <section className="flex min-h-0 flex-1 flex-col" aria-label="邮件提醒"><div className="p-6"><h1 className="text-xl font-semibold">邮件提醒</h1><p className="mt-3 text-sm text-ink-secondary">请登录正式账号后使用服务端邮件提醒。提醒不会保存模型密钥，也不依赖客户端保持打开。</p></div></section>;
  return <section className="flex min-h-0 flex-1 flex-col" aria-label="邮件提醒">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-3"><Bell size={17} className="text-brand" /><strong>邮件提醒</strong><button aria-label="刷新邮件提醒" className="work-icon ml-auto" onClick={() => void refresh()} disabled={busy}><RefreshCw size={16} /></button></div>
    <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-6"><div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
      <div><h2 className="text-base font-semibold">新建提醒</h2><p className="mt-2 text-xs text-ink-secondary">收件人固定为当前账号邮箱：{user?.email ?? "未设置"}。时间按 {timezone} 输入，服务端保存 UTC。</p>
        {capabilities && !capabilities.email_reminders_enabled && <p className="mt-3 border border-line p-3 text-sm text-ink-secondary">邮件提醒功能当前未启用。管理员需同时开启邮件和提醒配置。</p>}
        <form className="mt-4 grid gap-4" onSubmit={(event) => void create(event)}><label className="work-label">主题<input aria-label="提醒主题" className="work-input" maxLength={200} required value={subject} onChange={(event) => setSubject(event.target.value)} /></label><label className="work-label">提醒内容<textarea aria-label="提醒内容" className="work-input min-h-32 resize-y" maxLength={100000} required value={body} onChange={(event) => setBody(event.target.value)} /></label><label className="work-label">时间（{timezone}）<input aria-label="提醒时间" type="datetime-local" className="work-input" required value={nextRun} onChange={(event) => setNextRun(event.target.value)} /></label><label className="work-label">重复<select aria-label="提醒重复规则" className="work-input" value={recurrence} onChange={(event) => setRecurrence(event.target.value as ReminderRecurrence)}><option value="once">一次</option><option value="daily">每天</option><option value="weekly">每周</option></select></label><button className="work-command justify-center bg-brand text-white" disabled={busy || !canCreate}><Bell size={16} />保存提醒</button></form>
      </div>
      <div><div className="flex items-center justify-between gap-3"><h2 className="text-base font-semibold">已安排提醒</h2><span className="text-xs text-ink-secondary">{sorted.length} 条</span></div>{!sorted.length && <p className="mt-4 text-sm text-ink-secondary">还没有服务端提醒。</p>}<div className="mt-3 grid gap-3">{sorted.map(item => <article key={item.id} className="border border-line p-4"><div className="flex flex-wrap items-start gap-2"><div className="min-w-0 flex-1"><h3 className="break-words font-medium">{item.subject}</h3><p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink-secondary">{item.body}</p></div><span className="shrink-0 text-xs text-ink-secondary">{statusLabels[item.status]}</span></div><div className="mt-3 grid gap-1 text-xs text-ink-secondary"><span>{recurrenceLabels[item.recurrence]} · {formatDate(item.next_run_at)}</span><span>收件人：{item.recipient}</span></div><div className="mt-3 flex flex-wrap gap-2">{item.status === "active" && <button className="work-command" disabled={busy} onClick={() => void change(item, "paused")}><Pause size={15} />暂停</button>}{item.status === "paused" && <button className="work-command" disabled={busy} onClick={() => void change(item, "active")}><Play size={15} />恢复</button>}{item.status === "active" || item.status === "paused" ? <button className="work-command" disabled={busy} onClick={() => void change(item, "cancelled")}><Square size={15} />取消</button> : null}<button className="work-command" disabled={busy} onClick={() => void showDeliveries(item)}>{expanded === item.id ? <ChevronUp size={15} /> : <ChevronDown size={15} />}投递记录</button></div>{expanded === item.id && <ul className="mt-3">{(deliveries[item.id] ?? []).length ? deliveries[item.id].map(delivery => <DeliveryRow key={delivery.id} delivery={delivery} onRetry={(delivery, acknowledge) => retry(item, delivery, acknowledge)} />) : <li className="border-t border-line pt-3 text-sm text-ink-secondary">尚未到达调度时间。</li>}</ul>}</article>)}</div></div>
      </div>
      {error && <p role="alert" className="text-sm text-danger lg:col-span-2">{error}</p>}{notice && <p role="status" className="text-sm lg:col-span-2">{notice}</p>}
    </div>
  </section>;
}
