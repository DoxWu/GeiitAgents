import { newWorkflow, validateWorkflow, type WorkflowDefinition, type WorkflowNode } from './definition';

const FORMAT = 'geiit-workflow-definition';
const VERSION = 1;
export const MAX_WORKFLOW_FILE_BYTES = 512 * 1024;

function assertRecord(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) throw new Error('工作流文件结构无效或包含未知字段。');
}

export function exportWorkflowDefinition(value: WorkflowDefinition): string {
  const workflow = validateWorkflow(value);
  const portable = {
    name: workflow.name,
    nodes: workflow.nodes.map(({ profileId: _profileId, ...node }) => node),
    edges: workflow.edges,
  };
  const result = JSON.stringify({ format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), workflow: portable }, null, 2);
  if (new TextEncoder().encode(result).byteLength > MAX_WORKFLOW_FILE_BYTES) throw new Error('工作流定义文件不能超过 512 KiB。');
  return result;
}

export function importWorkflowDefinition(text: string): WorkflowDefinition {
  if (new TextEncoder().encode(text).byteLength > MAX_WORKFLOW_FILE_BYTES) throw new Error('工作流定义文件不能超过 512 KiB。');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('工作流文件不是有效 JSON。'); }
  assertRecord(value, ['format', 'version', 'exportedAt', 'workflow']);
  if (value.format !== FORMAT || value.version !== VERSION || typeof value.exportedAt !== 'string' || !Number.isFinite(Date.parse(value.exportedAt))) {
    throw new Error('不支持此工作流文件格式或版本。');
  }
  assertRecord(value.workflow, ['name', 'nodes', 'edges']);
  if (!Array.isArray(value.workflow.nodes) || !Array.isArray(value.workflow.edges)) throw new Error('工作流步骤或连线格式无效。');
  const base = newWorkflow();
  const ids = new Map<string, string>();
  const nodes = value.workflow.nodes.map(raw => {
    assertRecord(raw, ['id', 'kind', 'title', 'x', 'y', 'text', 'includeInputs', 'profileId', 'categoryColumn', 'valueColumns', 'chartType', 'unit', 'condition']);
    if (typeof raw.id !== 'string' || ids.has(raw.id)) throw new Error('工作流步骤标识缺失或重复。');
    const id = crypto.randomUUID(); ids.set(raw.id, id);
    const node = { ...raw, id, ...(raw.profileId === undefined ? {} : { profileId: undefined }) } as unknown as WorkflowNode;
    delete (node as WorkflowNode & { profileId?: string }).profileId;
    return node;
  });
  const edges = value.workflow.edges.map(raw => {
    assertRecord(raw, ['from', 'to', 'when']);
    if (typeof raw.from !== 'string' || typeof raw.to !== 'string') throw new Error('工作流连线标识无效。');
    const from = ids.get(raw.from), to = ids.get(raw.to);
    if (!from || !to) throw new Error('工作流连线引用了不存在的步骤。');
    return { ...raw, from, to } as WorkflowDefinition['edges'][number];
  });
  return validateWorkflow({ ...base, name: value.workflow.name, nodes, edges });
}
