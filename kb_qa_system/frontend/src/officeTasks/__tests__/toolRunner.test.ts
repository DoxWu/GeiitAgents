import { webcrypto } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { runOfficeTools, type ToolCheckpoint } from '../toolRunner';
import { normalizeToolReply, validateToolMessages, type ToolCall, type ToolMessage, type ToolReply } from '../toolProtocol';
const input = { title: '报告', instruction: '检查 CSV，绘制图表并写报告', csv: '月份,销售额\n一月,120\n二月,180' };
const call = (id: string, name: ToolCall['function']['name'], args: unknown): ToolCall => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
const doc = (id = 'doc') => call(id, 'create_document', { title: '报告', markdown: '# 汇报\n\n销售额从 120 增至 180。' });
const reply = (...tool_calls: ToolCall[]): ToolReply => ({ content: null, tool_calls });
beforeEach(() => vi.stubGlobal('crypto', webcrypto)); afterEach(() => vi.unstubAllGlobals());

it('executes CSV inspection, deterministic chart and document tools with ordered results and durable checkpoints', async () => {
  const events: ToolCheckpoint[] = [];
  const model = vi.fn<(messages: ToolMessage[]) => Promise<ToolReply>>()
    .mockResolvedValueOnce(reply(call('csv', 'inspect_csv', {})))
    .mockImplementationOnce(async messages => {
      const result = JSON.parse(messages.at(-1)!.content!); expect(result.rows).toEqual([['一月', '120'], ['二月', '180']]);
      return reply(call('chart', 'render_chart', { title: '销售额', category_column: 0, value_columns: [1], chart_type: 'bar', unit: '元' }), doc());
    }).mockImplementationOnce(async messages => { validateToolMessages(messages); return { content: '图表和文档已完成。', tool_calls: [] }; });
  expect(await runOfficeTools('task', input, new AbortController().signal, model, async event => { events.push(event); })).toContain('已完成');
  expect(events.filter(event => event.artifact).map(event => event.artifact!.kind)).toEqual(['svg', 'markdown']);
  expect(events.find(event => event.artifact?.kind === 'svg')?.artifact?.content).toContain('120');
  expect(events.filter(event => event.step.status === 'running')).toHaveLength(6);
  expect(model).toHaveBeenCalledTimes(3);
});

it('returns invalid arguments as tool errors for a bounded repair, never as execution instructions', async () => {
  const events: ToolCheckpoint[] = [];
  const model = vi.fn().mockResolvedValueOnce(reply(call('invalid', 'create_document', '{')))
    .mockImplementationOnce(async (messages: ToolMessage[]) => { expect(JSON.parse(messages.at(-1)!.content!).ok).toBe(false); return reply(doc('fixed')); })
    .mockResolvedValueOnce({ content: '完成', tool_calls: [] });
  await runOfficeTools('task', input, new AbortController().signal, model, async event => { events.push(event); });
  expect(events.filter(event => event.artifact)).toHaveLength(1);
  expect(events.some(event => event.step.callId === 'invalid' && event.step.status === 'failed')).toBe(true);
});

it('refuses unknown tools and duplicate call IDs before executing them', async () => {
  const artifacts: ToolCheckpoint[] = [];
  const checkpoint = async (event: ToolCheckpoint) => { if (event.artifact) artifacts.push(event); };
  await expect(runOfficeTools('task', input, new AbortController().signal, vi.fn().mockResolvedValue(reply({ ...doc(), function: { name: 'run_shell' as never, arguments: '{}' } })), checkpoint)).rejects.toThrow('未允许');
  expect(artifacts).toHaveLength(0);
  await expect(runOfficeTools('task', input, new AbortController().signal, vi.fn().mockResolvedValue(reply(doc())), checkpoint)).rejects.toThrow('重复');
  expect(artifacts).toHaveLength(1);
});

it('stops on checkpoint failure before model calls or tool execution', async () => {
  const model = vi.fn().mockResolvedValue(reply(doc()));
  await expect(runOfficeTools('task', input, new AbortController().signal, model, async () => { throw new Error('storage'); })).rejects.toThrow('storage');
  expect(model).not.toHaveBeenCalled();
  const events: ToolCheckpoint[] = [];
  await expect(runOfficeTools('task', input, new AbortController().signal, model, async event => { events.push(event); if (event.step.callId) throw new Error('storage'); })).rejects.toThrow('storage');
  expect(events.some(event => event.artifact)).toBe(false);
});

it('rejects late model results after cancellation and never makes an artifact', async () => {
  const controller = new AbortController(), events: ToolCheckpoint[] = [];
  const model = vi.fn().mockImplementation(async () => { controller.abort(); return reply(doc()); });
  await expect(runOfficeTools('task', input, controller.signal, model, async event => { events.push(event); })).rejects.toMatchObject({ name: 'AbortError' });
  expect(events).toHaveLength(1); expect(events[0].artifact).toBeUndefined();
});

it('limits model rounds and tool executions instead of claiming unfinished work succeeded', async () => {
  let round = 0;
  const model = vi.fn().mockImplementation(async () => reply(call('csv-' + round++, 'inspect_csv', {})));
  await expect(runOfficeTools('task', input, new AbortController().signal, model, async () => {})).rejects.toThrow('6 轮');
  expect(model).toHaveBeenCalledTimes(6);
  round = 0; let artifacts = 0;
  const many = vi.fn().mockImplementation(async () => reply(...Array.from({ length: 4 }, () => doc('doc-' + round++))));
  await expect(runOfficeTools('task', input, new AbortController().signal, many, async event => { if (event.artifact) artifacts++; })).rejects.toThrow('8 次');
  expect(artifacts).toBe(8);
});

it('does not call plain model text a completed office task', async () => {
  await expect(runOfficeTools('task', input, new AbortController().signal, vi.fn().mockResolvedValue({ content: '我已经替你完成', tool_calls: [] }), async () => {})).rejects.toThrow('未生成文件');
});

it('checks the transcript for missing, orphaned or repeated tool results', () => {
  const modelMessage: ToolMessage = { role: 'assistant', content: null, tool_calls: [doc()] };
  expect(() => validateToolMessages([modelMessage])).toThrow('尚未齐备');
  expect(() => validateToolMessages([{ role: 'tool', content: '{}', tool_call_id: 'missing' }])).toThrow('顺序');
  const valid: ToolMessage[] = [modelMessage, { role: 'tool', content: '{}', tool_call_id: 'doc' }];
  expect(() => validateToolMessages(valid)).not.toThrow();
  expect(() => validateToolMessages([...valid, modelMessage])).toThrow('重复');
  expect(normalizeToolReply({ content: 'ok', debug: 'fixture-secret' })).toEqual({ content: 'ok', tool_calls: [] });
});
