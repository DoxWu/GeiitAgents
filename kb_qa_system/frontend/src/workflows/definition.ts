import { validateAgent, type AgentDefinition } from '@/agents/definition';
import { validateCapability, type CapabilityResource } from '@/agents/capabilities';
import { functionContract, newFunction, validateFunction, type WorkflowFunction } from './functions';
import { stableJson } from '@/utils/stableJson';
export type WorkflowNodeKind = 'inspect_csv' | 'render_chart' | 'create_document' | 'generate_document' | 'condition' | 'loop' | 'agent' | 'function' | 'agent_condition' | 'trigger';
export interface AgentInputBinding { source: 'reference' | 'csv' | 'previous' | 'literal' | 'step'; value: string; nodeId?: string; field?: string }
export type WorkflowConditionSource = 'reference' | 'csv' | 'previous';
export type WorkflowConditionOperator = 'contains' | 'not_contains' | 'equals' | 'not_equals' | 'exists' | 'not_exists' | 'gt' | 'gte' | 'lt' | 'lte';
export interface WorkflowCondition {
  source: WorkflowConditionSource;
  operator: WorkflowConditionOperator;
  value: string;
}
export interface WorkflowLoop { maxIterations: number; stopWhen: string }
export interface WorkflowNode {
  id: string; kind: WorkflowNodeKind; title: string; x: number; y: number;
  text: string; includeInputs: boolean; profileId?: string;
  categoryColumn: number; valueColumns: number[]; chartType: 'bar' | 'horizontal_bar' | 'line' | 'pie' | 'scatter'; unit: string;
  condition?: WorkflowCondition; loop?: WorkflowLoop;
  fn?: WorkflowFunction; functionBranch?: boolean;
  capability?: CapabilityResource;
  trigger?: { kind: 'manual' | 'interval' | 'event'; intervalMinutes?: number; eventName?: string };
  agent?: AgentDefinition; bindings?: Record<string, AgentInputBinding>;
}
export interface WorkflowDefinition {
  id: string; name: string; revision: number; updatedAt: string;
  nodes: WorkflowNode[]; edges: { from: string; to: string; when?: 'true' | 'false' }[];
}
export function pruneAgentStepBindings(definition: WorkflowDefinition): WorkflowDefinition {
  return { ...definition, nodes: definition.nodes.map(node => {
    if (!nodeContract(node) || !node.bindings) return node;
    const bindings = Object.fromEntries(Object.entries(node.bindings).filter(([, binding]) =>
      binding.source !== 'step' || definition.edges.some(edge => edge.from === binding.nodeId && edge.to === node.id)));
    return { ...node, bindings };
  }) };
}
export interface WorkflowInput { reference: string; csv: string; triggerNodeId?: string }
export function nodeContract(node: WorkflowNode) { return node.kind === 'function' && node.fn ? functionContract(node.fn) : node.agent; }
export function isBranchNode(node: Pick<WorkflowNode, 'kind' | 'functionBranch'>) { return node.kind === 'condition' || node.kind === 'agent_condition' || node.kind === 'function' && node.functionBranch === true; }
export const NODE_LABELS: Record<WorkflowNodeKind, string> = {
  inspect_csv: '检查 CSV', render_chart: '生成图表', create_document: '整理 Markdown', generate_document: '模型生成文档', condition: '条件分支', loop: '有界循环', agent: '仓库智能体', function: '调用函数', agent_condition: '智能体判断', trigger: '触发事件',
};
export function newWorkflowNode(kind: WorkflowNodeKind, index: number): WorkflowNode {
  return { id: crypto.randomUUID(), kind, title: NODE_LABELS[kind], x: 24 + (index % 3) * 250, y: 24 + Math.floor(index / 3) * 150,
    text: ['generate_document', 'loop'].includes(kind) ? '根据参考材料与前置步骤结果整理报告，标注待确认事项。' : '# 工作记录', includeInputs: true,
    categoryColumn: 0, valueColumns: [1], chartType: 'bar', unit: '',
    ...(kind === 'function' ? { fn: newFunction(), bindings: {}, functionBranch: false } : {}),
    ...(kind === 'trigger' ? { trigger: { kind: 'manual' as const } } : {}),
    ...(kind === 'condition' ? { condition: { source: 'reference' as const, operator: 'contains' as const, value: '' } } : {}),
    ...(kind === 'loop' ? { loop: { maxIterations: 3, stopWhen: '' } } : {}) };
}
export function isWorkflowModelNode(node: Pick<WorkflowNode, 'kind'>): boolean { return ['generate_document', 'loop', 'agent', 'agent_condition'].includes(node.kind); }
export function maxWorkflowModelRequests(nodes: WorkflowNode[]): number {
  return nodes.reduce((sum, node) => sum + (node.kind === 'loop' ? node.loop?.maxIterations ?? 1 : node.agent?.capabilities?.some(r => r.kind !== 'skill') ? 7 : isWorkflowModelNode(node) ? 1 : 0), 0);
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
export function validateWorkflow(value: unknown, allowEmpty = false): WorkflowDefinition {
  const d = record(value, ['id', 'name', 'revision', 'updatedAt', 'nodes', 'edges']);
  text(d.id, 200, 1); text(d.name, 100, allowEmpty ? 0 : 1); integer(d.revision, 0, 1000000); text(d.updatedAt, 40, 1);
  if (!Number.isFinite(Date.parse(d.updatedAt))) fail();
  if (!Array.isArray(d.nodes) || (!allowEmpty && !d.nodes.length) || d.nodes.length > 12) fail('工作流需要 1–12 个步骤。');
  if (!Array.isArray(d.edges) || d.edges.length > 66) fail();
  for (const value of d.nodes) {
    const n = record(value, ['id', 'kind', 'title', 'x', 'y', 'text', 'includeInputs', 'profileId', 'categoryColumn', 'valueColumns', 'chartType', 'unit', 'condition', 'loop', 'agent', 'bindings', 'fn', 'functionBranch', 'trigger', 'capability']);
    text(n.id, 200, 1); text(n.title, 80, allowEmpty ? 0 : 1); text(n.text, isWorkflowModelNode({ kind: n.kind as WorkflowNodeKind }) ? 10000 : 50000);
    text(n.unit, 20); integer(n.x, 0, 2000); integer(n.y, 0, 2000); integer(n.categoryColumn, 0, 11);
    if (typeof n.kind !== 'string' || !Object.prototype.hasOwnProperty.call(NODE_LABELS, n.kind) || typeof n.includeInputs !== 'boolean'
      || !['bar', 'horizontal_bar', 'line', 'pie', 'scatter'].includes(String(n.chartType)) || !Array.isArray(n.valueColumns) || !n.valueColumns.length || n.valueColumns.length > 6
      || n.chartType === 'pie' && n.valueColumns.length !== 1) fail();
    n.valueColumns.forEach(v => integer(v, 0, 11));
    if (new Set(n.valueColumns).size !== n.valueColumns.length || n.valueColumns.includes(n.categoryColumn)) fail('数值列不能重复或与分类列相同。');
    if (!allowEmpty && !['agent', 'agent_condition'].includes(String(n.kind)) && isWorkflowModelNode({ kind: n.kind as WorkflowNodeKind }) && !n.text.trim()) fail('模型步骤需要生成要求。');
    if (n.kind === 'function') {
      if (n.agent !== undefined) fail('函数节点不能携带智能体配置。');
      if (n.fn === undefined && allowEmpty) continue;
      validateFunction(n.fn);
      if (n.capability !== undefined) {
        const resource = validateCapability(n.capability), fn = structuredClone(n.fn) as WorkflowFunction;
        if (resource.kind !== 'tool') fail('函数只能绑定工具资源。');
        if (resource.fn) resource.fn.reviewed = false; fn.reviewed = false;
        if (stableJson(resource.fn) !== stableJson(fn)) fail('工具函数与固定版本不一致。');
      }
      if (typeof n.functionBranch !== 'boolean') fail('请选择函数是否为判断节点。');
    } else if (n.fn !== undefined || n.functionBranch !== undefined || n.capability !== undefined) fail('函数配置仅适用于函数节点。');
    if (n.kind === 'trigger') {
      const trigger = record(n.trigger, ['kind', 'intervalMinutes', 'eventName']);
      if (!['manual', 'interval', 'event'].includes(String(trigger.kind))) fail('触发方式无效。');
      if (trigger.kind === 'interval') integer(trigger.intervalMinutes, 5, 43200);
      else if (trigger.intervalMinutes !== undefined) fail();
      if (trigger.kind === 'event') text(trigger.eventName, 100, 1);
      else if (trigger.eventName !== undefined) fail();
    } else if (n.trigger !== undefined) fail('触发配置仅适用于触发节点。');
    if (['agent', 'agent_condition', 'function'].includes(String(n.kind))) {
      if (n.agent === undefined && n.fn === undefined && allowEmpty) continue;
      const agent = n.kind === 'function' ? functionContract(validateFunction(n.fn)) : validateAgent(n.agent);
      if (isBranchNode(n as unknown as WorkflowNode) && !agent.outputFields.some(f => f.key === 'decision' && f.type === 'boolean' && f.required)) fail('判断节点需要必填的 decision: boolean 输出。');
      const bindings = record(n.bindings, agent.inputFields.map(field => field.key));
      for (const field of agent.inputFields) {
        if (bindings[field.key] === undefined && (!field.required || allowEmpty)) continue;
        const binding = record(bindings[field.key], ['source', 'value', 'nodeId', 'field']);
        if (!['reference', 'csv', 'previous', 'literal', 'step'].includes(String(binding.source))) fail('智能体输入映射来源无效。');
        text(binding.value, 50000);
        if (binding.source === 'step') { text(binding.nodeId, 200, 1); text(binding.field, 40, 1); }
        else if (binding.nodeId !== undefined || binding.field !== undefined) fail('只有步骤字段映射可以引用前置步骤。');
        if (field.type !== 'string' && !['literal', 'step'].includes(String(binding.source))) fail('数字和布尔输入需要使用固定值或类型相同的前置字段。');
        if (binding.source === 'literal' && field.type === 'number' && (!binding.value.trim() || !Number.isFinite(Number(binding.value)))) fail('固定输入必须是有限数字。');
        if (binding.source === 'literal' && field.type === 'boolean' && !['true', 'false'].includes(binding.value)) fail('布尔固定值必须是 true 或 false。');
      }
    } else if (n.agent !== undefined || n.bindings !== undefined) fail('智能体定义和输入映射只能用于智能体步骤。');
    if (n.profileId !== undefined) {
      if (!isWorkflowModelNode({ kind: n.kind as WorkflowNodeKind })) fail('只有模型步骤可以指定模型连接。');
      text(n.profileId, 200, 1);
    }
    if (n.kind === 'condition') {
      const condition = record(n.condition, ['source', 'operator', 'value']);
      if (!['reference', 'csv', 'previous'].includes(String(condition.source))
        || !['contains', 'not_contains', 'equals', 'not_equals', 'exists', 'not_exists', 'gt', 'gte', 'lt', 'lte'].includes(String(condition.operator))) fail();
      text(condition.value, 1000);
    } else if (n.condition !== undefined) fail('条件只能用于条件步骤。');
    if (n.kind === 'loop') {
      const loop = record(n.loop, ['maxIterations', 'stopWhen']);
      integer(loop.maxIterations, 1, 5); text(loop.stopWhen, 1000);
    } else if (n.loop !== undefined) fail('有界循环参数只能用于循环步骤。');
    if ([...n.title + n.unit].some(c => c.charCodeAt(0) < 32)) fail('步骤标题与单位不能包含控制字符。');
  }
  const definition = value as WorkflowDefinition;
  const ids = new Set(definition.nodes.map(n => n.id));
  if (ids.size !== definition.nodes.length) fail('步骤标识重复。');
  const pairs = new Set<string>();
  const incomingKinds = new Map<string, boolean>();
  for (const value of d.edges) {
    const e = record(value, ['from', 'to', 'when']); text(e.from, 200, 1); text(e.to, 200, 1);
    if (e.when !== undefined && !['true', 'false'].includes(String(e.when))) fail();
    const sourceNode = definition.nodes.find(node => node.id === e.from);
    if (e.when !== undefined && (!sourceNode || !isBranchNode(sourceNode))) fail('只有条件步骤可以使用 true/false 连线。');
    if (sourceNode && isBranchNode(sourceNode) && e.when === undefined) fail('条件步骤的出线必须标注分支值。');
    if (definition.nodes.find(n => n.id === e.to)?.kind === 'trigger') fail('触发事件不能有前置连线。');
    const labeled = e.when !== undefined;
    if (incomingKinds.has(e.to) && incomingKinds.get(e.to) !== labeled) fail('同一目标步骤不能混用条件分支连线与普通连线。');
    incomingKinds.set(e.to, labeled);
    const pair = JSON.stringify([e.from, e.to, e.when ?? null]);
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to || pairs.has(pair)) fail('连线包含缺失步骤、自连接或重复连接。');
    pairs.add(pair);
  }
  for (const node of definition.nodes.filter(n => ['agent', 'agent_condition', 'function'].includes(n.kind))) {
    for (const [key, binding] of Object.entries(node.bindings ?? {})) {
      if (binding.source !== 'step') continue;
      const source = definition.nodes.find(n => n.id === binding.nodeId);
      const output = source && nodeContract(source)?.outputFields.find(field => field.key === binding.field);
      if (!source || !nodeContract(source) || !output || output.type !== nodeContract(node)?.inputFields.find(field => field.key === key)?.type
        || !definition.edges.some(edge => edge.from === source.id && edge.to === node.id)) fail('智能体字段映射必须引用直接连入的智能体，并且字段类型一致。');
    }
  }
  if (definition.nodes.filter(isWorkflowModelNode).length > 6) fail('每个工作流最多 6 个模型步骤。');
  if (maxWorkflowModelRequests(definition.nodes) > 30) fail('每个工作流最多发起 30 次模型请求。');
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

/** Generate a deterministic, bounded layout without changing graph semantics. */
export function autoLayoutWorkflow(definition: WorkflowDefinition): WorkflowDefinition {
  const order = workflowOrder(definition), levels = new Map<string, number>();
  for (const node of order) {
    const parents = definition.edges.filter(edge => edge.to === node.id).map(edge => levels.get(edge.from) ?? 0);
    levels.set(node.id, parents.length ? Math.max(...parents) + 1 : 0);
  }
  const columns = new Map<number, WorkflowNode[]>();
  for (const node of order) {
    const level = levels.get(node.id) ?? 0, list = columns.get(level) ?? [];
    list.push(node); columns.set(level, list);
  }
  const positions = new Map<string, { x: number; y: number }>();
  const bandHeights = new Map<number, number>();
  for (const [level, nodes] of columns) {
    const band = Math.floor(level / 7);
    bandHeights.set(band, Math.max(bandHeights.get(band) ?? 0, nodes.length));
  }
  for (const [level, nodes] of columns) nodes.forEach((node, index) => {
    const band = Math.floor(level / 7), column = level % 7;
    const row = Array.from(bandHeights).reduce((sum, [otherBand, rows]) => sum + (otherBand < band ? rows : 0), index);
    positions.set(node.id, { x: Math.min(2000, 24 + column * 280), y: Math.min(2000, 24 + row * 170) });
  });
  return { ...definition, nodes: definition.nodes.map(node => ({ ...node, ...(positions.get(node.id) ?? { x: node.x, y: node.y }) })) };
}
export function validateWorkflowInput(value: unknown): WorkflowInput {
  const input = record(value, ['reference', 'csv', 'triggerNodeId']);
  if (input.triggerNodeId !== undefined) text(input.triggerNodeId, 200, 1); text(input.reference, 50000); text(input.csv, 100000);
  return { reference: input.reference, csv: input.csv, ...(input.triggerNodeId ? { triggerNodeId: String(input.triggerNodeId) } : {}) };
}
