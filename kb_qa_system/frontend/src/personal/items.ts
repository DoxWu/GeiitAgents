export type TodoStatus = 'open' | 'done' | 'cancelled';
export type Priority = 'normal' | 'high' | 'low';
export interface ItemFields { title: string; content: string; tags: string[] }
export type PersonalInput = ItemFields & ({ kind: 'note' } | { kind: 'todo'; status: TodoStatus; priority: Priority; dueAt: string | null });
export type PersonalItem = PersonalInput & { id: string; revision: number; createdAt: string; updatedAt: string; completedAt: string | null };

export function validatePersonalInput(input: PersonalInput): PersonalInput {
  const title = input.title.trim();
  if (!title || title.length > 120 || /[\r\n]/.test(title) || title.includes('\0')) throw new Error('标题需要 1–120 个字符且不换行。');
  if (input.content.length > 20000 || input.content.includes('\0')) throw new Error('内容最多 20000 个字符，不能包含空字符。');
  const tags = [...new Set(input.tags.map(tag => tag.trim()).filter(Boolean))];
  if (tags.length > 8 || tags.some(tag => tag.length > 30 || /[\r\n]/.test(tag) || tag.includes('\0'))) throw new Error('最多 8 个标签，每个最多 30 个字符且不换行。');
  if (input.kind === 'note') return { kind: 'note', title, content: input.content, tags };
  if (input.kind !== 'todo' || !['open', 'done', 'cancelled'].includes(input.status) || !['normal', 'high', 'low'].includes(input.priority)) throw new Error('待办类型、状态或优先级无效。');
  if (input.dueAt !== null && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.dueAt) || !Number.isFinite(Date.parse(input.dueAt)) || new Date(input.dueAt).toISOString() !== input.dueAt)) throw new Error('截止时间必须是有效的 UTC 时间。');
  return { kind: 'todo', title, content: input.content, tags, status: input.status, priority: input.priority, dueAt: input.dueAt };
}

export function isOverdue(item: PersonalItem, now = Date.now()): boolean {
  return item.kind === 'todo' && item.status === 'open' && item.dueAt !== null && Date.parse(item.dueAt) < now;
}

export function localDateInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso), pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function localDateToUtc(value: string): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('请选择有效的截止时间。');
  const date = new Date(value);
  // Round-trip rejects invalid dates and skipped wall-clock times at DST transitions.
  if (!Number.isFinite(date.getTime()) || localDateInput(date.toISOString()) !== value) throw new Error('该本地时间不存在，请重新选择。');
  // Reject ambiguous wall time as well; never silently choose one DST occurrence.
  for (let minutes = -180; minutes <= 180; minutes++) {
    if (minutes && localDateInput(new Date(date.getTime() + minutes * 60000).toISOString()) === value) throw new Error('该时间因夏令时出现两次，请选择其他时间。');
  }
  return date.toISOString();
}

export function personalMarkdown(item: PersonalItem): string {
  const details = [`类型：${item.kind === 'note' ? '笔记' : '待办'}`, `标签：${item.tags.join('、') || '无'}`, `更新时间：${item.updatedAt}`];
  if (item.kind === 'todo') details.push(`状态：${{ open: '待完成', done: '已完成', cancelled: '已取消' }[item.status]}`, `优先级：${{ normal: '普通', high: '高', low: '低' }[item.priority]}`, `截止时间（UTC）：${item.dueAt ?? '未设置'}`);
  return `# ${item.title}\n\n${details.join('\n\n')}\n\n---\n\n${item.content}\n`;
}
