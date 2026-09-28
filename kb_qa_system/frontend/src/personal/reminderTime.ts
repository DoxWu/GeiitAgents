// Resolve wall times in the reminder's IANA zone, independently of device zone.
// Gaps are rejected; overlaps return both UTC instants for explicit selection.
function formatter(timezone: string) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
  catch { throw new Error('请输入有效的 IANA 时区，例如 Asia/Shanghai。'); }
}
function parts(date: Date, format: Intl.DateTimeFormat) {
  return Object.fromEntries(format.formatToParts(date).map(part => [part.type, part.value]));
}
export function wallTime(instant: string, timezone: string): string {
  const p = parts(new Date(instant), formatter(timezone));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
export function wallTimeCandidates(value: string, timezone: string): string[] {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error('请输入完整的提醒日期和时间。');
  const [, y, m, d, h, min] = match.map(Number), naive = Date.UTC(y, m - 1, d, h, min);
  if (y < 1970 || y > 2100 || new Date(naive).toISOString().slice(0, 16) !== value) throw new Error('提醒日期无效，年份须在 1970–2100 之间。');
  const format = formatter(timezone), offsets = new Set<number>();
  // Sampling both sides of the local date covers DST and non-hour offsets.
  for (let hours = -48; hours <= 48; hours += 6) {
    const stamp = naive + hours * 3600000, p = parts(new Date(stamp), format);
    offsets.add(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - stamp);
  }
  return [...offsets].map(offset => new Date(naive - offset).toISOString()).filter(instant => wallTime(instant, timezone) === value).sort();
}
export function resolveReminderTime(value: string, timezone: string, selected: string, now = Date.now()): string {
  const candidates = wallTimeCandidates(value, timezone);
  if (!candidates.length) throw new Error('该时区在此时刻发生夏令时跳变，时间不存在，请选择其他时间。');
  const instant = candidates.length === 1 ? candidates[0] : candidates.find(value => value === selected);
  if (!instant) throw new Error('该时刻因时区回拨出现两次，请选择第一次或第二次。');
  if (Date.parse(instant) <= now) throw new Error('提醒时间必须晚于当前时间。');
  return instant;
}
export function formatReminderDate(value: string | null, timezone?: string) {
  if (!value) return '未安排';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZoneName: 'shortOffset', hourCycle: 'h23' }).format(new Date(value));
}
