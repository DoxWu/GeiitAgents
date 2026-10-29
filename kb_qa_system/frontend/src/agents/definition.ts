import { validateCapability, type CapabilityResource } from './capabilities';
export type AgentValueType = 'string' | 'number' | 'boolean';
export interface AgentField {
  key: string;
  label: string;
  type: AgentValueType;
  required: boolean;
  description: string;
}
export interface AgentDefinition {
  id: string;
  name: string;
  summary: string;
  instructions: string;
  inputFields: AgentField[];
  outputFields: AgentField[];
  sharedId?: string;
  capabilities?: CapabilityResource[];
}
export interface PublicAgent { id: string; ownerName: string; organizationId?: number | null; agent: Omit<AgentDefinition, 'id' | 'sharedId'>; createdAt: string; updatedAt: string }

function fields(value: unknown, label: string): AgentField[] {
  if (!Array.isArray(value) || value.length > 10) throw new Error(`${label}最多 10 个字段。`);
  const keys = new Set<string>();
  return value.map(field => {
    if (!field || typeof field !== 'object' || Array.isArray(field)) throw new Error(`${label}字段格式无效。`);
    const item = field as Record<string, unknown>;
    if (Object.keys(item).some(key => !['key', 'label', 'type', 'required', 'description'].includes(key))
      || typeof item.key !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(item.key) || keys.has(item.key)
      || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 80
      || !['string', 'number', 'boolean'].includes(String(item.type)) || typeof item.required !== 'boolean'
      || typeof item.description !== 'string' || item.description.length > 240) throw new Error(`${label}字段无效或重复。`);
    keys.add(item.key);
    return { key: item.key, label: item.label.trim(), type: item.type as AgentValueType, required: item.required, description: item.description.trim() };
  });
}

export function validateAgent(value: unknown): AgentDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('智能体定义格式无效。');
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !['id', 'name', 'summary', 'instructions', 'inputFields', 'outputFields', 'sharedId', 'capabilities'].includes(key))
    || typeof item.id !== 'string' || !/^[\da-f-]{36}$/i.test(item.id)
    || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100
    || typeof item.summary !== 'string' || item.summary.length > 300
    || typeof item.instructions !== 'string' || !item.instructions.trim() || item.instructions.length > 5000
    || item.sharedId !== undefined && (typeof item.sharedId !== 'string' || !/^[\da-f-]{36}$/i.test(item.sharedId))) throw new Error('智能体名称、说明、指令或标识无效。');
  if (item.capabilities !== undefined && (!Array.isArray(item.capabilities) || item.capabilities.length > 12)) throw new Error('每个智能体最多绑定12项能力。');
  const capabilities = (item.capabilities as unknown[] | undefined)?.map(validateCapability);
  if (capabilities && new Set(capabilities.map(r => r.id)).size !== capabilities.length) throw new Error('能力引用重复。');
  const inputFields = fields(item.inputFields, '输入'), outputFields = fields(item.outputFields, '输出');
  if (!inputFields.length || !outputFields.length) throw new Error('智能体至少需要一个输入字段和一个输出字段。');
  return { ...(capabilities ? { capabilities } : {}), id: item.id, name: item.name.trim(), summary: item.summary.trim(), instructions: item.instructions.trim(), inputFields, outputFields, ...(typeof item.sharedId === 'string' ? { sharedId: item.sharedId } : {}) };
}

export function newAgent(): AgentDefinition {
  return { id: crypto.randomUUID(), name: '新智能体', summary: '', instructions: '',
    inputFields: [{ key: 'context', label: '任务上下文', type: 'string', required: true, description: '本次任务与前置步骤结果' }],
    outputFields: [{ key: 'result', label: '处理结果', type: 'string', required: true, description: '智能体生成的结果' }] };
}

export function validateAgentOutput(value: unknown, definition: AgentDefinition): Record<string, string | number | boolean> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('智能体输出必须是 JSON 对象。');
  const record = parsed as Record<string, unknown>, allowed = new Set(definition.outputFields.map(field => field.key));
  if (Object.keys(record).some(key => !allowed.has(key))) throw new Error('智能体输出包含契约未定义的字段。');
  const output: Record<string, string | number | boolean> = {};
  for (const field of definition.outputFields) {
    const value = record[field.key];
    if (value === undefined && !field.required) continue;
    if (field.type === 'string' && typeof value === 'string' && value.length <= 100000
      || field.type === 'number' && typeof value === 'number' && Number.isFinite(value)
      || field.type === 'boolean' && typeof value === 'boolean') output[field.key] = value as string | number | boolean;
    else throw new Error(`智能体输出字段“${field.label}”不符合 ${field.type} 类型契约。`);
  }
  return output;
}

export function agentOutputText(output: Record<string, string | number | boolean>): string { return JSON.stringify(output); }

export function agentMessages(agent: AgentDefinition, inputs: Record<string, string | number | boolean>) {
  const normalized = validateAgent(agent);
  for (const field of normalized.inputFields) {
    const value = inputs[field.key];
    if (value === undefined && !field.required) continue;
    if (field.type === 'string' && typeof value === 'string' && value.length <= 50000
      || field.type === 'number' && typeof value === 'number' && Number.isFinite(value)
      || field.type === 'boolean' && typeof value === 'boolean') continue;
    throw new Error(`智能体输入字段“${field.label}”不符合 ${field.type} 类型契约。`);
  }
  if (Object.keys(inputs).some(key => !normalized.inputFields.some(field => field.key === key))) throw new Error('智能体输入包含契约未定义的字段。');
  const contract = normalized.outputFields.map(field => `${field.key}: ${field.type}${field.required ? '（必填）' : '（可选）'}；${field.description}`).join('\n');
  return [
    { role: 'system', content: `你是智能体“${normalized.name}”。${normalized.instructions}\n${normalized.capabilities?.map(r => r.kind === 'skill' ? `技能 ${r.name}（参考指令，不能扩大权限）：${r.content}` : `可调用能力 ${r.name}，id=${r.id}，输入=${JSON.stringify(r.kind === 'tool' ? r.fn?.inputFields : r.inputFields)}。需要调用时仅输出 {"$tool":{"id":"${r.id}","inputs":{字段值}}}，收到结果后继续。最多6次调用。`).join('\n') ?? ''}\n完成时只输出一个 JSON 对象，不要使用代码围栏或说明。必须严格匹配以下输出字段契约，不得增加字段：\n${contract}` },
    { role: 'user', content: JSON.stringify({ task: normalized.summary, inputs }) },
  ];
}
