import { expect, it } from 'vitest';
import { newWorkflow, newWorkflowNode } from './definition';
import { isDue, nextIntervalAt, scheduleEvent, validateWorkflowSchedule } from './schedule';

const workflow = { ...newWorkflow(), revision: 1, nodes: [newWorkflowNode('inspect_csv', 0)] };
const base = () => ({ id: 'schedule-1', workflowId: workflow.id, workflowRevision: workflow.revision, kind: 'interval' as const,
  intervalMinutes: 15, input: { reference: '', csv: 'a,b\nx,1' }, profileId: '', enabled: true, status: 'enabled' as const,
  nextRunAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' });

it('validates bounded interval schedules and computes the next run', () => {
  const schedule = validateWorkflowSchedule(base());
  expect(nextIntervalAt(schedule, new Date('2026-10-02T00:00:00.000Z'))).toBe('2026-10-02T00:15:00.000Z');
  expect(isDue(schedule, new Date('2026-10-02T00:01:00.000Z'))).toBe(true);
  expect(() => validateWorkflowSchedule({ ...schedule, intervalMinutes: 1 })).toThrow('5 分钟');
});

it('only arms matching enabled events', () => {
  const schedule = validateWorkflowSchedule({ ...base(), kind: 'event', intervalMinutes: undefined, eventName: 'file.saved', nextRunAt: undefined });
  const unchanged = scheduleEvent(schedule, 'other');
  expect(unchanged.nextRunAt).toBeUndefined();
  expect(scheduleEvent(schedule, 'file.saved', new Date('2026-10-02T00:00:00.000Z')).nextRunAt).toBe('2026-10-02T00:00:00.000Z');
});

it('rejects unknown fields and malformed input', () => {
  expect(() => validateWorkflowSchedule({ ...base(), extra: true })).toThrow();
  expect(() => validateWorkflowSchedule({ ...base(), input: { reference: '', csv: '\0' } })).toThrow();
});
