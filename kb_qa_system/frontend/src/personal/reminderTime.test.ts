import { expect, it } from 'vitest';
import { resolveReminderTime, wallTime, wallTimeCandidates } from './reminderTime';

it('converts the selected zone independently from the device, including quarter-hour offsets', () => {
  expect(resolveReminderTime('2099-01-02T09:00', 'Asia/Shanghai', '')).toBe('2099-01-02T01:00:00.000Z');
  expect(resolveReminderTime('2099-01-02T09:00', 'Asia/Kathmandu', '')).toBe('2099-01-02T03:15:00.000Z');
  expect(wallTime('2099-01-02T01:00:00Z', 'Asia/Shanghai')).toBe('2099-01-02T09:00');
});
it('rejects missing DST wall times and requires a choice for repeated times', () => {
  expect(wallTimeCandidates('2026-03-08T02:30', 'America/New_York')).toEqual([]);
  expect(() => resolveReminderTime('2026-03-08T02:30', 'America/New_York', '', 0)).toThrow('不存在');
  const candidates = wallTimeCandidates('2026-11-01T01:30', 'America/New_York');
  expect(candidates).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']);
  expect(() => resolveReminderTime('2026-11-01T01:30', 'America/New_York', '', 0)).toThrow('出现两次');
  expect(resolveReminderTime('2026-11-01T01:30', 'America/New_York', candidates[1], 0)).toBe(candidates[1]);
});
it('handles a half-hour DST transition', () => {
  expect(wallTimeCandidates('2026-04-05T01:45', 'Australia/Lord_Howe')).toEqual(['2026-04-04T14:45:00.000Z', '2026-04-04T15:15:00.000Z']);
});
it('rejects invalid dates, zones and past schedules without normalizing them silently', () => {
  for (const value of ['2099-02-29T12:00', '2099-01-01T24:00', '2101-01-01T09:00', 'not-a-date']) expect(() => wallTimeCandidates(value, 'UTC')).toThrow();
  expect(() => wallTimeCandidates('2099-01-01T09:00', 'Invalid/Zone')).toThrow('IANA');
  expect(() => resolveReminderTime('2000-01-01T09:00', 'UTC', '')).toThrow('晚于');
});
