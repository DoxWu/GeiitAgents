import { validateWorkflowInput, type WorkflowInput } from './definition';

export type WorkflowScheduleKind = 'interval' | 'event';
export type WorkflowScheduleStatus = 'enabled' | 'paused' | 'awaiting-device' | 'awaiting-authorization' | 'error';

export interface WorkflowSchedule {
  id: string;
  workflowId: string;
  workflowRevision: number;
  kind: WorkflowScheduleKind;
  intervalMinutes?: number;
  eventName?: string;
  input: WorkflowInput;
  profileId: string;
  enabled: boolean;
  status: WorkflowScheduleStatus;
  nextRunAt?: string;
  lastRunAt?: string;
  lastError?: string;
  updatedAt: string;
}

const fail = (message = '工作流触发配置无效。'): never => { throw new Error(message); };
const text = (value: unknown, max: number, min = 0): string => {
  if (typeof value !== 'string' || value.length > max || value.trim().length < min || value.includes('\0')) fail();
  return value as string;
};
const date = (value: unknown) => { const parsed = text(value, 40, 1); if (!Number.isFinite(Date.parse(parsed))) fail(); };

export function validateWorkflowSchedule(value: unknown): WorkflowSchedule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  const allowed = ['id', 'workflowId', 'workflowRevision', 'kind', 'intervalMinutes', 'eventName', 'input', 'profileId', 'enabled', 'status', 'nextRunAt', 'lastRunAt', 'lastError', 'updatedAt'];
  if (Object.keys(record).some(key => !allowed.includes(key))) fail();
  text(record.id, 200, 1); text(record.workflowId, 200, 1); text(record.profileId, 200);
  if (!Number.isInteger(record.workflowRevision) || Number(record.workflowRevision) < 1 || Number(record.workflowRevision) > 1_000_000) fail();
  if (record.kind !== 'interval' && record.kind !== 'event') fail();
  if (record.kind === 'interval') {
    if (!Number.isInteger(record.intervalMinutes) || Number(record.intervalMinutes) < 5 || Number(record.intervalMinutes) > 43_200) fail('定时触发间隔须为 5 分钟至 30 天。');
    if (record.eventName !== undefined) fail();
  } else {
    text(record.eventName, 100, 1);
    if (record.intervalMinutes !== undefined) fail();
  }
  validateWorkflowInput(record.input);
  if (typeof record.enabled !== 'boolean' || !['enabled', 'paused', 'awaiting-device', 'awaiting-authorization', 'error'].includes(String(record.status))) fail();
  if (record.nextRunAt !== undefined) date(record.nextRunAt);
  if (record.lastRunAt !== undefined) date(record.lastRunAt);
  if (record.lastError !== undefined) text(record.lastError, 1000);
  date(record.updatedAt);
  return JSON.parse(JSON.stringify(value)) as WorkflowSchedule;
}

export function nextIntervalAt(schedule: Pick<WorkflowSchedule, 'intervalMinutes'>, from = new Date()): string {
  const minutes = schedule.intervalMinutes;
  if (!Number.isInteger(minutes) || minutes! < 5 || minutes! > 43_200) throw new Error('定时触发间隔无效。');
  return new Date(from.getTime() + minutes! * 60_000).toISOString();
}

export function isDue(schedule: WorkflowSchedule, now = new Date()): boolean {
  return schedule.enabled && schedule.status === 'enabled' && Boolean(schedule.nextRunAt) && Date.parse(schedule.nextRunAt!) <= now.getTime();
}

export function scheduleEvent(schedule: WorkflowSchedule, eventName: string, now = new Date()): WorkflowSchedule {
  if (!schedule.enabled || schedule.status !== 'enabled' || schedule.kind !== 'event' || schedule.eventName !== eventName) return schedule;
  return { ...schedule, nextRunAt: now.toISOString(), updatedAt: now.toISOString() };
}
