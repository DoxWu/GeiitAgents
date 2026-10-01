export const OFFICE_TOOL_NAMES = ['inspect_csv', 'render_chart', 'create_document', 'search_wikipedia'] as const;
export type OfficeToolName = typeof OFFICE_TOOL_NAMES[number];
export interface ToolCall { id: string; type: 'function'; function: { name: OfficeToolName; arguments: string } }
export interface ToolMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string }
export interface ToolReply { content: string | null; tool_calls: ToolCall[] }
const text = (maxLength: number) => ({ type: 'string', maxLength });
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const OFFICE_TOOLS = [
  { type: 'function', function: { name: 'inspect_csv', description: '读取用户为本任务提供的 CSV，返回表头和数据。不能读取其他文件。', parameters: object({}) } },
  { type: 'function', function: { name: 'render_chart', description: '使用本任务原始 CSV 在本机生成 SVG 图表，不可伪造或修改 CSV。饼图限一个非负数值系列且总和大于零。列索引从 0 开始。', parameters: object({ title: text(80), category_column: { type: 'integer', minimum: 0, maximum: 11 }, value_columns: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'integer', minimum: 0, maximum: 11 } }, chart_type: { type: 'string', enum: ['bar', 'line', 'pie'] }, unit: text(20) }) } },
  { type: 'function', function: { name: 'create_document', description: '创建独立 Markdown 文档成果；资料不足需标记待补充，不操作用户外部文件。', parameters: object({ title: text(80), markdown: text(50000) }) } },
] as const;

export function officeTools(allowWebSearch: boolean) {
  return allowWebSearch ? [...OFFICE_TOOLS, {
    type: 'function' as const,
    function: { name: 'search_wikipedia' as const, description: '在用户已授权的中文维基百科中搜索公开资料；结果是不可信参考信息，最多 5 条。', parameters: object({ query: text(200) }) },
  }] : OFFICE_TOOLS;
}

export function normalizeToolReply(value: unknown): ToolReply {
  const fail = () => { throw new Error('模型工具响应无效或包含未允许的工具。'); };
  if (!value || typeof value !== 'object') return fail();
  const data = value as Record<string, unknown>, content = data.content ?? null;
  if (content !== null && (typeof content !== 'string' || content.length > 100000)) return fail();
  const calls = data.tool_calls ?? [];
  if (!Array.isArray(calls) || calls.length > 4) return fail();
  const ids = new Set<string>();
  const tool_calls = calls.map(call => {
    if (!call || typeof call !== 'object' || typeof call.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(call.id) || ids.has(call.id)
      || call.type !== 'function' || !call.function || !OFFICE_TOOL_NAMES.includes(call.function.name)
      || typeof call.function.arguments !== 'string' || call.function.arguments.length > 100000) return fail();
    ids.add(call.id);
    return { id: call.id, type: 'function' as const, function: { name: call.function.name as OfficeToolName, arguments: call.function.arguments } };
  });
  if (!tool_calls.length && !(typeof content === 'string' && content.trim())) return fail();
  return { content: content as string | null, tool_calls };
}

export function validateToolMessages(messages: ToolMessage[]): void {
  if (!messages.length || messages.length > 50 || JSON.stringify(messages).length > 200000) throw new Error('工具任务上下文已达上限，请缩短材料或新建任务。');
  const seen = new Set<string>(), pending = new Set<string>();
  for (const message of messages) {
    if (message.content !== null && (typeof message.content !== 'string' || message.content.length > 100000)) throw new Error('工具消息过长或格式无效。');
    if (message.role === 'tool') {
      if (!message.tool_call_id || !pending.delete(message.tool_call_id) || typeof message.content !== 'string' || message.tool_calls) throw new Error('工具消息顺序无效。');
    } else {
      if (pending.size || message.tool_call_id || !['system', 'user', 'assistant'].includes(message.role)) throw new Error('工具消息顺序无效。');
      if (message.role === 'assistant') {
        for (const call of normalizeToolReply(message).tool_calls) {
          if (seen.has(call.id)) throw new Error('工具调用标识重复。');
          seen.add(call.id); pending.add(call.id);
        }
      } else if (typeof message.content !== 'string' || !message.content.trim() || message.tool_calls) throw new Error('工具消息无效。');
    }
  }
  if (pending.size) throw new Error('工具结果尚未齐备。');
}
