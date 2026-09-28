import { describe, expect, it } from 'vitest';
import { makeRenamePlan, planMarkdown, proposeName } from './plan';

const files = [
  { path: 'a.txt', name: 'a.txt', size: 3, modifiedAt: Date.parse('2026-09-01T00:00:00Z'), type: 'text/plain' },
  { path: 'b.txt', name: 'b.txt', size: 4, modifiedAt: Date.parse('2026-09-01T00:00:00Z'), type: 'text/plain' },
];
describe('file organizer plan', () => {
  it('sanitizes names and keeps extensions', () => expect(proposeName({ ...files[0], name: '季度<报告>.TXT' }, '项目/归档')).toBe('项目_归档_2026-09-01_季度_报告_.txt'));
  it('makes deterministic duplicate suffixes and conflict statuses', () => {
    const plan = makeRenamePlan(files, '归档');
    expect(plan.map(item => item.target)).toEqual(['归档_2026-09-01_a.txt', '归档_2026-09-01_b.txt']);
    expect(planMarkdown(plan)).toContain('| 原路径 | 新文件名 |');
    const conflict = makeRenamePlan([{ ...files[0], name: '归档_2026-09-01_a.txt', path: '归档_2026-09-01_a.txt' }, files[0]], '归档');
    expect(conflict.some(item => item.status === 'conflict')).toBe(true);
  });
});
