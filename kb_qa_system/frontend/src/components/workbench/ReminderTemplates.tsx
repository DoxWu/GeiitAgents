import { useState } from 'react';
import { useWorkbenchStore } from '@/store/workbenchStore';
import { REMINDER_PRESETS, type ReminderForm } from '@/personal/reminderDraft';

export function ReminderTemplates({ owner, form, disabled, onApply }: { owner: string; form: ReminderForm; disabled: boolean; onApply: (form: ReminderForm) => void }) {
  const templates = useWorkbenchStore(state => state.reminderTemplates), [selected, setSelected] = useState(''), [name, setName] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const own = templates.filter(item => item.owner === owner);
  function apply() {
    const item = REMINDER_PRESETS.find(item => item.id === selected) || own.find(item => item.id === selected);
    if (!item) return;
    onApply({ ...form, subject: item.subject, body: item.body, recurrence: item.recurrence, ...('timezone' in item ? { timezone: item.timezone, selected: '' } : {}) });
  }
  async function save(remove = false) {
    setBusy(true); setError('');
    try {
      if (remove) { await useWorkbenchStore.getState().removeReminderTemplate(owner, selected); setSelected(''); }
      else { const id = crypto.randomUUID(); await useWorkbenchStore.getState().saveReminderTemplate({ id, owner, name, subject: form.subject, body: form.body, timezone: form.timezone, recurrence: form.recurrence }); setSelected(id); setName(''); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '模板保存失败。'); }
    finally { setBusy(false); }
  }
  return <details className="mb-4 rounded border border-line p-3"><summary>提醒模板</summary><fieldset className="mt-3 grid min-w-0 gap-3" disabled={disabled || busy}>
    <label className="work-label">选择提醒模板<select className="work-input" value={selected} onChange={event => setSelected(event.target.value)}><option value="">请选择</option><optgroup label="内置模板">{REMINDER_PRESETS.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup><optgroup label="当前账号的本机模板">{own.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup></select></label>
    <p className="text-xs text-ink-secondary">模板只填充主题、内容、重复规则及可选时区，不包含日期、收件人或提交标识。应用后请确认下一次时间，再保存提醒。</p>
    <div className="flex flex-wrap gap-2"><button type="button" className="work-command" disabled={!selected} onClick={apply}>应用模板</button>{own.some(item => item.id === selected) && <button type="button" className="work-command" onClick={() => void save(true)}>删除模板</button>}</div>
    <label className="work-label">新模板名称<input className="work-input" maxLength={60} value={name} onChange={event => setName(event.target.value)} /></label>
    <button type="button" className="work-command" disabled={!name.trim() || !form.subject.trim() || !form.body.trim()} onClick={() => void save()}>将当前内容保存为模板</button>
    <p className="text-xs text-ink-secondary">自定义模板只保存到本机加密库，按服务端地址与账号区分，不同步到服务器。</p>
  </fieldset>{error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}</details>;
}
