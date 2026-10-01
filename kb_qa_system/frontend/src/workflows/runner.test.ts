import { webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { newWorkflow, newWorkflowNode, validateWorkflow, workflowOrder } from './definition';
import { evaluateWorkflowCondition, prepareWorkflow, runWorkflow, WORKFLOW_SKIPPED_RESULT } from './runner';
import type { ToolCheckpoint } from '@/officeTasks/toolRunner';

beforeEach(() => { vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('TextEncoder', TextEncoder); });
afterEach(() => vi.unstubAllGlobals());
const input = { reference: '参考材料', csv: '月份,销量\n一月,12\n二月,18' };
function graph() {
  const read = newWorkflowNode('inspect_csv', 0), chart = newWorkflowNode('render_chart', 1), doc = newWorkflowNode('create_document', 2);
  return { ...newWorkflow(), nodes: [doc, chart, read], edges: [{ from: read.id, to: chart.id }, { from: chart.id, to: doc.id }, { from: read.id, to: doc.id }] };
}
it('topologically executes a fork/join graph and reuses actual CSV/chart/document tools', async () => {
  const d = graph(), events: ToolCheckpoint[] = [], model = vi.fn();
  expect(workflowOrder(d).map(n => n.kind)).toEqual(['inspect_csv', 'render_chart', 'create_document']);
  await runWorkflow('task', d, input, new AbortController().signal, model, async event => { events.push(event); });
  expect(model).not.toHaveBeenCalled();
  expect(events.map(e => e.step.status)).toEqual(['running', 'succeeded', 'running', 'succeeded', 'running', 'succeeded']);
  const artifacts = events.flatMap(e => e.artifact ? [e.artifact] : []);
  expect(artifacts[0].content).toContain('<svg'); expect(artifacts[1].content).toContain('一月'); expect(artifacts[1].content).toContain(artifacts[0].sha256);
  expect(new Set(events.map(e => e.step.workflowNodeId)).size).toBe(3);
});
it.each(['cycle', 'duplicate', 'dangling', 'self', 'code', 'too-many'] as const)('rejects %s before execution', kind => {
  const d = graph();
  if (kind === 'cycle') d.edges.push({ from: d.nodes[0].id, to: d.nodes[2].id });
  if (kind === 'duplicate') d.nodes[0].id = d.nodes[1].id;
  if (kind === 'dangling') d.edges[0].from = 'missing';
  if (kind === 'self') d.edges.push({ from: d.nodes[0].id, to: d.nodes[0].id });
  if (kind === 'code') Object.assign(d.nodes[0], { script: 'doNotRun()' });
  if (kind === 'too-many') d.nodes = Array.from({ length: 13 }, (_, i) => newWorkflowNode('inspect_csv', i));
  expect(() => validateWorkflow(d)).toThrow();
});
it('preflights static chart data without dispatching a model', () => {
  expect(() => prepareWorkflow(graph(), { reference: '', csv: 'x,y\na,=cmd()' })).toThrow('数值缺失或格式无效');
});
it('accepts and preflights a one-series pie chart workflow node', () => {
  const chart = newWorkflowNode('render_chart', 0); chart.chartType = 'pie'; chart.valueColumns = [1];
  const definition = { ...newWorkflow(), nodes: [chart] };
  expect(validateWorkflow(definition).nodes[0].chartType).toBe('pie');
  expect(() => prepareWorkflow(definition, { reference: '', csv: 'x,y\na,-1' })).toThrow('不支持负数');
  chart.valueColumns = [1, 2];
  expect(() => validateWorkflow(definition)).toThrow();
});
it('accepts a horizontal bar chart workflow definition', () => {
  const chart = newWorkflowNode('render_chart', 0); chart.chartType = 'horizontal_bar';
  const definition = { ...newWorkflow(), nodes: [chart] };
  expect(validateWorkflow(definition).nodes[0].chartType).toBe('horizontal_bar');
  expect(prepareWorkflow(definition, input).definition.nodes[0].chartType).toBe('horizontal_bar');
});

it('validates and executes only the selected condition branch', async () => {
  const condition = newWorkflowNode('condition', 0), yes = newWorkflowNode('create_document', 1), no = newWorkflowNode('create_document', 2);
  condition.condition = { source: 'reference', operator: 'contains', value: 'run' };
  yes.text = 'selected branch'; no.text = 'unselected branch';
  const definition = { ...newWorkflow(), nodes: [condition, yes, no], edges: [{ from: condition.id, to: yes.id, when: 'true' as const }, { from: condition.id, to: no.id, when: 'false' as const }] }, events: ToolCheckpoint[] = [];
  await runWorkflow('task', definition, { reference: 'please run this', csv: '' }, new AbortController().signal, vi.fn(), async event => { events.push(event); });
  expect(events).toHaveLength(5);
  expect(events[0].step.tool).toBe('workflow.condition');
  expect(events[2].step.workflowNodeId).toBe(yes.id);
  expect(events[4].step.workflowNodeId).toBe(no.id);
  expect(events[4].step.warnings).toContain('条件分支未命中，步骤已跳过。');
  expect(events[4].step.result).toBe('__geiit_workflow_skipped__');
});

it('rejects unlabeled outgoing edges from condition nodes', () => {
  const condition = newWorkflowNode('condition', 0), next = newWorkflowNode('create_document', 1);
  expect(() => validateWorkflow({ ...newWorkflow(), nodes: [condition, next], edges: [{ from: condition.id, to: next.id }] })).toThrow('条件步骤的出线必须标注分支值');
});
it('rejects mixed conditional and ordinary incoming edges', () => {
  const condition = newWorkflowNode('condition', 0), ordinary = newWorkflowNode('create_document', 1), target = newWorkflowNode('create_document', 2);
  expect(() => validateWorkflow({ ...newWorkflow(), nodes: [condition, ordinary, target], edges: [
    { from: condition.id, to: target.id, when: 'true' as const }, { from: ordinary.id, to: target.id },
  ] })).toThrow('不能混用条件分支连线与普通连线');
});

it.each([true, false])('joins the executed branch and preserves skipped descendants (condition %s)', async selected => {
  const condition = newWorkflowNode('condition', 0), yes = newWorkflowNode('create_document', 1), no = newWorkflowNode('create_document', 2);
  const descendant = newWorkflowNode('generate_document', 3), join = newWorkflowNode('create_document', 4);
  condition.condition = { source: 'reference', operator: 'equals', value: 'yes' };
  yes.includeInputs = false; yes.text = 'YES CONTENT'; no.includeInputs = false; no.text = 'NO CONTENT'; join.includeInputs = false;
  const definition = { ...newWorkflow(), nodes: [condition, yes, no, descendant, join], edges: [
    { from: condition.id, to: yes.id, when: 'true' as const }, { from: condition.id, to: no.id, when: 'false' as const },
    { from: no.id, to: descendant.id }, { from: yes.id, to: join.id }, { from: no.id, to: join.id },
  ] }, events: ToolCheckpoint[] = [], model = vi.fn().mockResolvedValue({ content: 'done', model: 'fixture', finishReason: 'stop' });
  await runWorkflow('task', definition, { reference: selected ? 'yes' : 'no', csv: '' }, new AbortController().signal, model, async e => { events.push(e); });
  const artifact = events.find(e => e.step.workflowNodeId === join.id && e.artifact)?.artifact;
  expect(artifact?.content).toContain(selected ? 'YES CONTENT' : 'NO CONTENT');
  expect(artifact?.content).not.toContain(selected ? 'NO CONTENT' : 'YES CONTENT');
  expect(artifact?.content).not.toContain(WORKFLOW_SKIPPED_RESULT);
  expect(model).toHaveBeenCalledTimes(selected ? 0 : 1);
});

it('restores condition decisions and skipped checkpoints without replaying rejected models', async () => {
  const condition = newWorkflowNode('condition', 0), no = newWorkflowNode('generate_document', 1), join = newWorkflowNode('generate_document', 2);
  const definition = { ...newWorkflow(), nodes: [condition, no, join], edges: [
    { from: condition.id, to: no.id, when: 'false' as const }, { from: no.id, to: join.id },
  ] }, events: ToolCheckpoint[] = [], model = vi.fn();
  await expect(runWorkflow('task', definition, { reference: '', csv: '' }, new AbortController().signal, model, async e => { events.push(e); },
    { completedResults: new Map([[condition.id, 'true'], [no.id, WORKFLOW_SKIPPED_RESULT]]) })).resolves.toContain('跳过 2 个');
  expect(model).not.toHaveBeenCalled();
  expect(events).toHaveLength(1); expect(events[0].step.result).toBe(WORKFLOW_SKIPPED_RESULT);
});

it.each(['', ' ', 'not numeric', 'Infinity'])('does not interpret invalid numeric source %j as a number', source => {
  expect(evaluateWorkflowCondition({ source: 'reference', operator: 'lte', value: '0' }, { reference: source, csv: '' }, '')).toBe(false);
});
it('compares finite numeric values and distinguishes empty from zero', () => {
  const values = { reference: ' 12.5 ', csv: '' };
  expect(evaluateWorkflowCondition({ source: 'reference', operator: 'gte', value: '12.5' }, values, '')).toBe(true);
  expect(evaluateWorkflowCondition({ source: 'reference', operator: 'lt', value: '13' }, values, '')).toBe(true);
  expect(evaluateWorkflowCondition({ source: 'reference', operator: 'gt', value: '' }, values, '')).toBe(false);
  expect(evaluateWorkflowCondition({ source: 'previous', operator: 'equals', value: 'previous' }, values, 'previous')).toBe(true);
  expect(evaluateWorkflowCondition({ source: 'csv', operator: 'not_exists', value: '' }, values, '')).toBe(true);
});

it('does not impose the model JSON context limit on local-only nodes', async () => {
  const node = newWorkflowNode('inspect_csv', 0), csv = 'name,value\n' + Array.from({ length: 49 }, () => 'x'.repeat(1900) + ',1').join('\n');
  const d = { ...newWorkflow(), nodes: [node] };
  await expect(runWorkflow('task', d, { reference: 'a'.repeat(50000), csv }, new AbortController().signal, vi.fn(), async () => {})).resolves.toContain('1 个步骤');
});
it('passes only direct predecessor outputs and opted-in inputs into model source data', async () => {
  const parent = newWorkflowNode('create_document', 0), unrelated = newWorkflowNode('create_document', 1), generated = newWorkflowNode('generate_document', 2);
  parent.includeInputs = false; parent.text = 'SELECTED'; unrelated.text = 'NOT_SELECTED'; generated.includeInputs = false;
  const d = { ...newWorkflow(), nodes: [parent, unrelated, generated], edges: [{ from: parent.id, to: generated.id }] };
  const model = vi.fn().mockResolvedValue({ content: '回答', model: 'fixture', finishReason: 'stop' });
  await runWorkflow('task', d, input, new AbortController().signal, model, async () => {});
  const source = model.mock.calls[0][0].sourceContent;
  expect(source).toContain('SELECTED'); expect(source).not.toContain('NOT_SELECTED'); expect(source).not.toContain('参考材料'); expect(source).not.toContain('一月');
});
it('passes each generating node to the model resolver so routes can differ by step', async () => {
  const first = newWorkflowNode('generate_document', 0), second = newWorkflowNode('generate_document', 1);
  first.profileId = 'local-a'; second.profileId = 'local-b';
  const d = { ...newWorkflow(), nodes: [first, second], edges: [] };
  const model = vi.fn().mockResolvedValue({ content: '完成', model: 'fixture', finishReason: 'stop' });
  await runWorkflow('task', d, input, new AbortController().signal, model, async () => {});
  expect(model.mock.calls.map(call => call[1].profileId)).toEqual(['local-a', 'local-b']);
});
it('retains partial model artifact but stops downstream on non-normal completion', async () => {
  const generated = newWorkflowNode('generate_document', 0), after = newWorkflowNode('create_document', 1), events: ToolCheckpoint[] = [];
  const d = { ...newWorkflow(), nodes: [generated, after], edges: [{ from: generated.id, to: after.id }] };
  await expect(runWorkflow('task', d, input, new AbortController().signal, vi.fn().mockResolvedValue({ content: 'partial', model: 'fixture', finishReason: 'length' }), async e => { events.push(e); })).rejects.toThrow('未报告正常完成');
  expect(events).toHaveLength(2); expect(events[1].artifact).toMatchObject({ finishReason: 'length', content: 'partial\n' });
});
it('does not execute a node when its running checkpoint cannot be persisted', async () => {
  const d = { ...newWorkflow(), nodes: [newWorkflowNode('generate_document', 0)] }, model = vi.fn();
  await expect(runWorkflow('task', d, input, new AbortController().signal, model, async () => { throw new Error('quota'); })).rejects.toThrow('quota');
  expect(model).not.toHaveBeenCalled();
});
it('does not execute the next node after successful checkpoint storage fails or cancellation occurs', async () => {
  for (const cancel of [false, true]) {
    const d = graph(), controller = new AbortController(), events: ToolCheckpoint[] = [];
    await expect(runWorkflow('task', d, input, controller.signal, vi.fn(), async e => {
      events.push(e); if (events.length === 2) { if (cancel) controller.abort(); else throw new Error('quota'); }
    })).rejects.toThrow();
    expect(events).toHaveLength(2);
  }
});
it('refuses oversized upstream context instead of silently truncating it', async () => {
  const generated = newWorkflowNode('generate_document', 0), after = newWorkflowNode('generate_document', 1);
  const d = { ...newWorkflow(), nodes: [generated, after], edges: [{ from: generated.id, to: after.id }] }, model = vi.fn().mockResolvedValue({ content: 'a'.repeat(100001), model: 'fixture', finishReason: 'stop' });
  await expect(runWorkflow('task', d, { reference: '', csv: '' }, new AbortController().signal, model, async () => {})).rejects.toThrow('超过 100000');
  expect(model).toHaveBeenCalledTimes(1);
});
