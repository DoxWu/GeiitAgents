export type WorkflowNodeKind = 'inspect_csv' | 'render_chart' | 'create_document' | 'generate_document';
export interface WorkflowNode {
  id: string; kind: WorkflowNodeKind; title: string; x: number; y: number;
  text: string; includeInputs: boolean;
  categoryColumn: number; valueColumns: number[]; chartType: 'bar' | 'line'; unit: string;
}
export interface WorkflowDefinition {
  id: string; name: string; revision: number; updatedAt: string;
  nodes: WorkflowNode[]; edges: { from: string; to: string }[];
}
export interface WorkflowInput { reference: string; csv: string }
export const NODE_LABELS: Record<WorkflowNodeKind, string> = {
  inspect_csv: '检查 CSV', render_chart: '生成图表', create_document: '整理 Markdown', generate_document: '模型生成文档',
};
export function newWorkflowNode(kind: WorkflowNodeKind, index: number): WorkflowNode {
  return { id: crypto.randomUUID(), kind, title: NODE_LABELS[kind], x: 24 + (index % 3) * 250, y: 24 + Math.floor(index / 3) * 150,
    text: kind === 'generate_document' ? '根据参考材料与前置步骤结果整理报告，标注待确认事项。' : '# 工作记录', includeInputs: true,
    categoryColumn: 0, valueColumns: [1], chartType: 'bar', unit: '' };
}
export function newWorkflow(): WorkflowDefinition {
  return { id: crypto.randomUUID(), name: '新工作流', revision: 0, updatedAt: new Date().toISOString(), nodes: [], edges: [] };
}
function fail(message = '工作流定义格式无效。'): never { throw new Error(message); }
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, min = 0): asserts value is string {
  if (typeof value !== 'string' || value.length > max || value.trim().length < min || value.includes('\0')) fail();
}
function integer(value: unknown, min: number, max: number) { if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) fail(); }

/** Full structural check also used for decrypted backups; never execute stored code. */
export function validateWorkflow(value: unknown): WorkflowDefinition {
  const d = record(value, ['id', 'name', 'revision', 'updatedAt', 'nodes', 'edges']);
  text(d.id, 200, 1); text(d.name, 100, 1); integer(d.revision, 0, 1000000); text(d.updatedAt, 40, 1);
  if (!Number.isFinite(Date.parse(d.updatedAt))) fail();
  if (!Array.isArray(d.nodes) || !d.nodes.length || d.nodes.length > 12) fail('工作流需要 1–12 个步骤。');
  if (!Array.isArray(d.edges) || d.edges.length > 66) fail();
  for (const value of d.nodes) {
    const n = record(value, ['id', 'kind', 'title', 'x', 'y', 'text', 'includeInputs', 'categoryColumn', 'valueColumns', 'chartType', 'unit']);
    text(n.id, 200, 1); text(n.title, 80, 1); text(n.text, n.kind === 'generate_document' ? 10000 : 50000);
    text(n.unit, 20); integer(n.x, 0, 2000); integer(n.y, 0, 2000); integer(n.categoryColumn, 0, 11);
    if (typeof n.kind !== 'string' || !Object.prototype.hasOwnProperty.call(NODE_LABELS, n.kind) || typeof n.includeInputs !== 'boolean'
      || !['bar', 'line'].includes(String(n.chartType)) || !Array.isArray(n.valueColumns) || !n.valueColumns.length || n.valueColumns.length > 6) fail();
    n.valueColumns.forEach(v => integer(v, 0, 11));
    if (new Set(n.valueColumns).size !== n.valueColumns.length || n.valueColumns.includes(n.categoryColumn)) fail('数值列不能重复或与分类列相同。');
    if (n.kind === 'generate_document' && !n.text.trim()) fail('模型步骤需要生成要求。');
    if ([...n.title + n.unit].some(c => c.charCodeAt(0) < 32)) fail('步骤标题与单位不能包含控制字符。');
  }
  const definition = value as WorkflowDefinition;
  const ids = new Set(definition.nodes.map(n => n.id));
  if (ids.size !== definition.nodes.length) fail('步骤标识重复。');
  const pairs = new Set<string>();
  for (const value of d.edges) {
    const e = record(value, ['from', 'to']); text(e.from, 200, 1); text(e.to, 200, 1);
    const pair = JSON.stringify([e.from, e.to]);
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to || pairs.has(pair)) fail('连线包含缺失步骤、自连接或重复连接。');
    pairs.add(pair);
  }
  if (definition.nodes.filter(n => n.kind === 'generate_document').length > 6) fail('每个工作流最多 6 个模型步骤。');
  workflowOrder(definition);
  return JSON.parse(JSON.stringify(definition)) as WorkflowDefinition;
}
export function workflowOrder(definition: WorkflowDefinition): WorkflowNode[] {
  const output: WorkflowNode[] = [], done = new Set<string>();
  while (done.size < definition.nodes.length) {
    const next = definition.nodes.find(n => !done.has(n.id) && definition.edges.filter(e => e.to === n.id).every(e => done.has(e.from)));
    if (!next) fail('工作流存在循环依赖，请删除环路中的连线。');
    output.push(next); done.add(next.id);
  }
  return output;
}
export function validateWorkflowInput(value: unknown): WorkflowInput {
  const input = record(value, ['reference', 'csv']); text(input.reference, 50000); text(input.csv, 100000);
  return { reference: input.reference, csv: input.csv };
}
