import { describe, expect, it } from 'vitest';
import { isOverdue, localDateInput, localDateToUtc, personalMarkdown, validatePersonalInput, type PersonalItem } from './items';

const note = { kind: 'note' as const, title: '笔记', content: '**材料**\n\n![remote](https://example.com/a.png)', tags: ['项目', '项目', ' 新事项 '] };
describe('personal item input', () => {
  it('preserves Markdown, bounds titles/content/tags and normalizes tag duplicates', () => {
    expect(validatePersonalInput(note)).toEqual({ ...note, tags: ['项目', '新事项'] });
    for (const patch of [{ title: ' ' }, { title: 'x'.repeat(121) }, { content: 'x'.repeat(20001) }, { tags: ['x'.repeat(31)] }, { tags: Array.from({ length: 9 }, (_, i) => String(i)) }]) expect(() => validatePersonalInput({ ...note, ...patch })).toThrow();
  });
  it('rejects normalized invalid dates and invalid todo settings', () => {
    const todo = { ...note, kind: 'todo' as const, status: 'open' as const, priority: 'normal' as const, dueAt: '2026-02-30T09:00:00.000Z' };
    expect(() => validatePersonalInput(todo)).toThrow();
    expect(() => validatePersonalInput({ ...todo, dueAt: '2026-10-01T09:00:00.000Z' })).not.toThrow();
    expect(() => validatePersonalInput({ ...todo, dueAt: '2026-10-01T09:00' })).toThrow();
  });
  it('round trips local input to UTC and rejects invalid wall-clock dates', () => {
    expect(localDateInput(localDateToUtc('2026-10-01T09:30'))).toBe('2026-10-01T09:30');
    expect(localDateToUtc('')).toBeNull();
    expect(() => localDateToUtc('2026-02-30T09:00')).toThrow();
    expect(() => localDateToUtc('tomorrow')).toThrow();
  });
  it('only open past-due todos are overdue; exports full content and UTC time', () => {
    const item: PersonalItem = { ...note, kind: 'todo', status: 'open', priority: 'high', dueAt: '2026-09-29T08:00:00.000Z', id: 'fixture', revision: 1, createdAt: '', updatedAt: '', completedAt: null };
    expect(isOverdue(item, Date.parse('2026-09-29T09:00Z'))).toBe(true);
    expect(isOverdue({ ...item, status: 'done' }, Date.parse('2026-09-29T09:00Z'))).toBe(false);
    expect(isOverdue({ ...item, dueAt: null })).toBe(false);
    expect(personalMarkdown(item)).toContain('2026-09-29T08:00:00.000Z');
    expect(personalMarkdown(item)).toContain(note.content);
  });
});
