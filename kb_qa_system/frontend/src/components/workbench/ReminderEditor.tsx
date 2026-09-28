import { useMemo, useState } from 'react';
import type { ReminderRecurrence, ServerReminder } from '@/api/personal';
import { formatReminderDate, resolveReminderTime, wallTime, wallTimeCandidates } from '@/personal/reminderTime';

export interface ReminderFields { subject: string; body: string; timezone: string; recurrence: ReminderRecurrence; next_run_at: string }
export type ReminderEdit = Partial<ReminderFields> & { status?: 'active' };
export function ReminderEditor({ original, resume = false, disabled, conflict, onSave, onCancel, onReload, onDirty }: {
  original?: ServerReminder; resume?: boolean; disabled: boolean; conflict: boolean;
  onSave: (fields: ReminderEdit) => Promise<void>; onCancel: () => void; onReload: () => void;
  onDirty: () => void;
}) {
  const initialZone = original?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const [initialTime] = useState(() => wallTime(original?.next_run_at || new Date(Date.now() + 3600000).toISOString(), initialZone));
  const [subject, setSubject] = useState(original?.subject || ''), [body, setBody] = useState(original?.body || '');
  const [timezone, setTimezone] = useState(initialZone), [time, setTime] = useState(initialTime);
  const [recurrence, setRecurrence] = useState<ReminderRecurrence>(original?.recurrence || 'once');
  const [selected, setSelected] = useState(original?.next_run_at ? new Date(original.next_run_at).toISOString() : '');
  const [reactivate, setReactivate] = useState(resume), [error, setError] = useState('');
  const candidates = useMemo(() => { try { return wallTimeCandidates(time, timezone); } catch { return []; } }, [time, timezone]);
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (disabled || conflict) return; setError('');
    try {
      const fields: ReminderEdit = {};
      if (!subject.trim() || !body.trim()) throw new Error('请填写提醒主题和内容。');
      if (!original || subject.trim() !== original.subject) fields.subject = subject.trim();
      if (!original || body.trim() !== original.body) fields.body = body.trim();
      const scheduleChanged = !original || time !== initialTime || timezone !== initialZone || recurrence !== original.recurrence;
      if (scheduleChanged || reactivate) {
        fields.next_run_at = resolveReminderTime(time, timezone, selected);
        fields.timezone = timezone; fields.recurrence = recurrence;
      }
      if (original?.status === 'paused' && reactivate) fields.status = 'active';
      if (!Object.keys(fields).length) throw new Error('尚未修改提醒。');
      await onSave(fields);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法保存提醒。'); }
  }
  return <section aria-label={original ? '编辑邮件提醒' : '新建邮件提醒'}>
    <h2 className="font-semibold">{original ? '编辑提醒 / 改期' : '新建提醒'}</h2>
    {original && <p className="mt-2 text-xs text-ink-secondary">当前编辑版本 {original.revision}。改期或更改规则会取消旧版本尚未发送的投递；已开始发送的邮件无法撤回。</p>}
    <form className="mt-4 grid gap-4" onChange={onDirty} onSubmit={event => void save(event)}>
      <fieldset disabled={disabled} className="grid min-w-0 gap-4">
        <label className="work-label">主题<input aria-label="提醒主题" className="work-input" maxLength={200} required value={subject} onChange={event => setSubject(event.target.value)} /></label>
        <label className="work-label">提醒内容<textarea aria-label="提醒内容" className="work-input min-h-32 resize-y" maxLength={100000} required value={body} onChange={event => setBody(event.target.value)} /></label>
        <label className="work-label">时区<input aria-label="提醒时区" className="work-input" maxLength={64} list="reminder-timezones" value={timezone} onChange={event => { setTimezone(event.target.value); setSelected(''); }} /><datalist id="reminder-timezones">{['Asia/Shanghai', 'Asia/Tokyo', 'Asia/Kathmandu', 'UTC', 'Europe/London', 'America/New_York', 'America/Los_Angeles'].map(zone => <option key={zone} value={zone} />)}</datalist></label>
        <label className="work-label">时间（所选时区）<input aria-label="提醒时间" type="datetime-local" className="work-input" required min="1970-01-01T00:00" max="2100-12-31T23:59" value={time} onChange={event => { setTime(event.target.value); setSelected(''); }} /></label>
        {candidates.length > 1 && <label className="work-label">此时刻出现两次，请选择<select aria-label="重复时刻选择" className="work-input" value={selected} onChange={event => setSelected(event.target.value)}><option value="">请选择第一次或第二次</option>{candidates.map((instant, index) => <option key={instant} value={instant}>{index === 0 ? '第一次' : '第二次'} · {formatReminderDate(instant, timezone)}</option>)}</select></label>}
        <label className="work-label">重复<select aria-label="提醒重复规则" className="work-input" value={recurrence} onChange={event => setRecurrence(event.target.value as ReminderRecurrence)}><option value="once">一次</option><option value="daily">每天</option><option value="weekly">每周</option></select></label>
        {recurrence !== 'once' && <p className="text-xs text-ink-secondary">按所选时区的本地时刻重复；每周按所选日期的星期执行。后续夏令时不存在的时刻顺延，重复时刻取第一次；停机期间错过的周期不逐一补发。</p>}
        {original?.status === 'paused' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={reactivate} onChange={event => setReactivate(event.target.checked)} />保存后恢复提醒</label>}
      </fieldset>
      {conflict && <div className="text-sm"><p>服务端版本已变化，草稿已保留。请先载入最新版本后重新编辑。</p><button type="button" className="work-command mt-2" disabled={disabled} onClick={onReload}>载入最新版本（放弃草稿）</button></div>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex flex-wrap gap-2"><button className="work-command justify-center bg-brand text-white" disabled={disabled || conflict || !subject.trim() || !body.trim()}>{original ? '保存修改' : '保存提醒'}</button>{original && <button type="button" className="work-command" disabled={disabled} onClick={onCancel}>退出编辑</button>}</div>
    </form>
  </section>;
}
