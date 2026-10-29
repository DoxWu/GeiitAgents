import { validateAgent, validateAgentOutput, type AgentField } from '@/agents/definition';

export interface WorkflowFunction {
  id: string; name: string; description: string; version: number;
  code: string; inputFields: AgentField[]; outputFields: AgentField[];
  reviewed: boolean;
}

export function functionContract(fn: WorkflowFunction) {
  return { id: fn.id, name: fn.name, summary: fn.description, instructions: '执行已确认函数', inputFields: fn.inputFields, outputFields: fn.outputFields };
}
export function validateFunction(value: unknown): WorkflowFunction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('函数定义无效。');
  const fn = value as WorkflowFunction;
  if (Object.keys(fn).some(key => !['id', 'name', 'description', 'version', 'code', 'inputFields', 'outputFields', 'reviewed'].includes(key))
    || typeof fn.code !== 'string' || !fn.code.trim() || fn.code.length > 20000 || fn.code.includes('\0')
    || !Number.isSafeInteger(fn.version) || fn.version < 1 || fn.version > 1000000 || typeof fn.reviewed !== 'boolean') throw new Error('函数代码、版本或确认状态无效。');
  validateAgent(functionContract(fn));
  return structuredClone(fn);
}
export function newFunction(): WorkflowFunction {
  return { id: crypto.randomUUID(), name: '文本处理函数', description: '整理输入文本，不调用外部服务。', version: 1,
    code: 'return { result: inputs.context.trim() };', reviewed: false,
    inputFields: [{ key: 'context', label: '上下文', type: 'string', required: true, description: '' }],
    outputFields: [{ key: 'result', label: '处理结果', type: 'string', required: true, description: '' }] };
}
export function validateFunctionResult(value: unknown, fn: WorkflowFunction) { return validateAgentOutput(value, functionContract(fn)); }

/** Every execution has a fresh guest VM with no host functions or credentials. */
export async function executeWorkflowFunction(fn: WorkflowFunction, inputs: Record<string, string | number | boolean>, signal: AbortSignal) {
  validateFunction(fn);
  const { agentMessages } = await import('@/agents/definition');
  agentMessages(functionContract(fn), inputs);
  if (!fn.reviewed) throw new Error('请先检查并确认函数代码与字段契约。');
  if (signal.aborted) throw new DOMException('已取消', 'AbortError');
  return new Promise<Record<string, string | number | boolean>>((resolve, reject) => {
    const worker = new Worker(new URL('./function.worker.ts', import.meta.url), { type: 'module' });
    const finish = (error?: Error, value?: unknown) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort); worker.terminate();
      if (error) reject(error);
      else { try { resolve(validateFunctionResult(value, fn)); } catch (reason) { reject(reason); } }
    };
    const abort = () => finish(new DOMException('已取消', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('函数初始化或执行超时，已停止。')), 10000);
    signal.addEventListener('abort', abort, { once: true });
    worker.onerror = () => finish(new Error('函数运行环境启动失败。'));
    worker.onmessage = event => event.data.error ? finish(new Error(String(event.data.error).slice(0, 500))) : finish(undefined, event.data.value);
    worker.postMessage({ code: fn.code, inputs });
  });
}
