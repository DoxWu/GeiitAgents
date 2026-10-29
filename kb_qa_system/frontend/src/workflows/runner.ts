import { executeOfficeTool, type ToolCheckpoint } from '@/officeTasks/toolRunner';
import { documentExportContent, normalizeDocumentMarkdown, sha256Text, type DocumentTaskInput } from '@/officeTasks/document';
import { checkChart, parseChartCsv } from '@/officeTasks/chart';
import type { FinishReason } from '@/services/modelStream';
import type { ToolRun, WorkArtifact } from '@/types/workbench';
import { agentMessages, validateAgentOutput } from '@/agents/definition';
import { executeWorkflowFunction } from './functions';
import { verifyCapability } from '@/api/capabilities';
import { isBranchNode, nodeContract, isWorkflowModelNode, validateWorkflow, validateWorkflowInput, workflowOrder, type WorkflowCondition, type WorkflowDefinition, type WorkflowInput, type WorkflowNode } from './definition';

export const WORKFLOW_SKIPPED_RESULT = '__geiit_workflow_skipped__';
function branchValue(result: string | undefined) {
  if (result === 'true' || result === 'false') return result;
  try { return String(JSON.parse(result ?? '').decision); } catch { return undefined; }
}

export function evaluateWorkflowCondition(condition: WorkflowCondition, input: WorkflowInput, previous: string): boolean {
  const source = condition.source === 'reference' ? input.reference : condition.source === 'csv' ? input.csv : previous;
  if (condition.operator === 'exists') return source.trim().length > 0;
  if (condition.operator === 'not_exists') return source.trim().length === 0;
  if (condition.operator === 'contains') return source.includes(condition.value);
  if (condition.operator === 'not_contains') return !source.includes(condition.value);
  if (condition.operator === 'equals') return source === condition.value;
  if (condition.operator === 'not_equals') return source !== condition.value;
  if (!source.trim() || !condition.value.trim()) return false;
  const left = Number(source), right = Number(condition.value);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  if (condition.operator === 'gt') return left > right;
  if (condition.operator === 'gte') return left >= right;
  if (condition.operator === 'lt') return left < right;
  return left <= right;
}

function toolName(node: WorkflowNode): ToolRun['tool'] {
  if (node.kind === 'trigger') return 'workflow.trigger';
  if (node.kind === 'function') return 'workflow.function';
  if (isBranchNode(node)) return 'workflow.condition';
  if (isWorkflowModelNode(node)) return 'model.complete';
  if (node.kind === 'inspect_csv' || node.kind === 'render_chart' || node.kind === 'create_document') return `office.${node.kind}`;
  throw new Error('工作流步骤类型无效。');
}
function loopIterationKey(nodeId: string, iteration: number) { return `workflow-loop:${nodeId}:${iteration}`; }

export interface WorkflowResumeOptions {
  completedResults?: Map<string, string>;
}

export function prepareWorkflow(definition: WorkflowDefinition, input: WorkflowInput) {
  const graph = validateWorkflow(definition), values = validateWorkflowInput(input);
  if (values.triggerNodeId && !graph.nodes.some(n => n.id === values.triggerNodeId && n.kind === 'trigger')) throw new Error('触发入口不存在。');
  if (graph.nodes.some(n => n.kind === 'function' && !n.fn?.reviewed)) throw new Error('请先检查并确认所有函数代码。');
  if (graph.nodes.some(n => n.agent?.capabilities?.some(resource => resource.fn && !resource.fn.reviewed))) throw new Error('智能体绑定了尚未检查确认的工具函数，请在资源仓库检查并重新绑定。');
  // Reject static CSV/chart errors before a model is charged or a task is created.
  for (const node of graph.nodes) {
    if (node.kind === 'inspect_csv') parseChartCsv(values.csv);
    if (node.kind === 'render_chart') checkChart({ ...node, csv: values.csv, valueColumn: node.valueColumns[0] });
  }
  return { definition: graph, input: values };
}
export async function runWorkflow(taskId: string, definition: WorkflowDefinition, input: WorkflowInput, signal: AbortSignal,
  model: (input: DocumentTaskInput, node: WorkflowDefinition['nodes'][number]) => Promise<{ content: string; model: string; finishReason: FinishReason }>,
  checkpoint: (event: ToolCheckpoint) => Promise<void>, options: WorkflowResumeOptions = {}): Promise<string> {
  const prepared = prepareWorkflow(definition, input), graph = prepared.definition, values = prepared.input;
  for (const node of graph.nodes) for (const resource of [...(node.agent?.capabilities ?? []), ...(node.capability ? [node.capability] : [])]) await verifyCapability(resource, signal);
  const results = new Map<string, string>(), skipped = new Set<string>();
  for (const [id, result] of options.completedResults ?? []) {
    results.set(id, result);
    if (result === WORKFLOW_SKIPPED_RESULT) skipped.add(id);
  }
  const guard = () => { if (signal.aborted) throw new DOMException('工作流已停止', 'AbortError'); };
  for (const node of workflowOrder(graph)) {
    guard();
    if (results.has(node.id)) continue;
    const incoming = graph.edges.filter(e => e.to === node.id);
    const enabled = incoming.filter(edge => !skipped.has(edge.from) && results.has(edge.from)
      && (edge.when === undefined || branchValue(results.get(edge.from)) === edge.when));
    // Topological ordering has already resolved every predecessor, including skipped paths.
    const selectedTrigger = values.triggerNodeId ?? graph.nodes.find(n => n.kind === 'trigger' && n.trigger?.kind === 'manual')?.id ?? graph.nodes.find(n => n.kind === 'trigger')?.id;
    const active = node.kind === 'trigger' ? node.id === selectedTrigger : incoming.length ? enabled.length > 0 : !selectedTrigger;
    if (!active) {
      const now = new Date().toISOString();
      await checkpoint({ step: { id: crypto.randomUUID(), taskId, workflowNodeId: node.id, tool: toolName(node), status: 'succeeded', startedAt: now, finishedAt: now,
        result: WORKFLOW_SKIPPED_RESULT, warnings: ['条件分支未命中，步骤已跳过。'] } });
      guard(); results.set(node.id, WORKFLOW_SKIPPED_RESULT); skipped.add(node.id); continue;
    }
    const sources = enabled.map(e => ({ step: graph.nodes.find(n => n.id === e.from)!.title, output: results.get(e.from)! }));
    const context = JSON.stringify({ ...(node.includeInputs ? { reference: values.reference, csv: values.csv } : {}), previousSteps: sources });
    if (isWorkflowModelNode(node) && context.length > 100000) throw new Error('前置步骤结果超过 100000 字符，请拆分工作流；不会静默截断。');
    const step: ToolRun = { id: crypto.randomUUID(), taskId, workflowNodeId: node.id, tool: toolName(node), status: 'running', startedAt: new Date().toISOString() };
    await checkpoint({ step }); guard();
    let artifact: WorkArtifact | undefined, result: string, modelName: string | undefined, finishReason: FinishReason | undefined;
    try {
      if (node.kind === 'trigger') { result = JSON.stringify(values);
      } else if (node.kind === 'condition') {
        result = String(evaluateWorkflowCondition(node.condition!, values, sources.map(source => source.output).join('\n')));
      } else if (node.kind === 'agent' || node.kind === 'agent_condition' || node.kind === 'function') {
        const agent = nodeContract(node)!, inputs: Record<string, string | number | boolean> = {};
        for (const field of agent.inputFields) {
          const binding = node.bindings?.[field.key];
          if (!binding) continue;
          if (binding.source === 'step') {
            if (!enabled.some(edge => edge.from === binding.nodeId)) throw new Error(`智能体输入“${field.label}”所引用的步骤未执行。`);
            const sourceNode = graph.nodes.find(n => n.id === binding.nodeId)!;
            const source = validateAgentOutput(results.get(binding.nodeId!), nodeContract(sourceNode)!);
            if (source[binding.field!] !== undefined) inputs[field.key] = source[binding.field!];
          } else {
            const value = binding.source === 'reference' ? values.reference : binding.source === 'csv' ? values.csv
              : binding.source === 'previous' ? sources.map(source => source.output).join('\n') : binding.value;
            inputs[field.key] = field.type === 'number' ? Number(value) : field.type === 'boolean' ? value === 'true' : value;
          }
        }
        agentMessages(agent, inputs); // Validate inputs before sending any model request.
        if (node.capability) await verifyCapability(node.capability, signal);
        guard();
        const reply = node.kind === 'function'
          ? { content: JSON.stringify(await executeWorkflowFunction(node.fn!, inputs, signal)), model: '本机隔离函数', finishReason: 'stop' as const }
          : await model({ title: node.title, instruction: '按智能体字段契约执行', agent, agentInputs: inputs }, node);
        guard();
        if (reply.finishReason !== 'stop') throw new Error('智能体未正常完成，输出不会进入后续步骤。');
        const output = validateAgentOutput(reply.content, agent);
        result = JSON.stringify(output);
        modelName = reply.model; finishReason = reply.finishReason;
      } else if (node.kind === 'generate_document' || node.kind === 'loop') {
        let reply: { content: string; model: string; finishReason: FinishReason };
        if (node.kind === 'loop') {
          let previousIteration = '';
          const maxIterations = node.loop!.maxIterations;
          for (let iteration = 1; iteration <= maxIterations; iteration++) {
            guard();
            const resumed = options.completedResults?.get(loopIterationKey(node.id, iteration));
            if (resumed !== undefined) {
              previousIteration = resumed;
              if (node.loop!.stopWhen && resumed.includes(node.loop!.stopWhen)) break;
              continue;
            }
            const iterationStep: ToolRun = { id: crypto.randomUUID(), taskId, workflowNodeId: node.id, tool: 'workflow.loop-iteration', callId: crypto.randomUUID(),
              arguments: JSON.stringify({ iteration, maxIterations }), status: 'running', startedAt: new Date().toISOString() };
            await checkpoint({ step: iterationStep }); guard();
            try {
              const sourceContent = JSON.stringify({ priorContext: context, previousIteration: previousIteration || undefined, iteration, maxIterations });
              if (sourceContent.length > 100000) throw new Error('循环步骤上下文超过 100000 字符。');
              const instruction = `${node.text}\n\n这是第 ${iteration}/${maxIterations} 轮。${node.loop!.stopWhen ? `若已满足要求，请在输出中包含停止标记：${node.loop!.stopWhen}` : '完成本轮后返回可直接使用的完整成果。'}`;
              const next = await model({ title: node.title, instruction, sourceName: '工作流循环上下文.json', sourceContent }, node);
              guard();
              if (next.finishReason !== 'stop') throw new Error('循环模型未报告正常完成，本轮结果不会进入后续步骤。');
              if (next.content.length > 100000) throw new Error('循环模型结果超过 100000 字符。');
              await checkpoint({ step: { ...iterationStep, status: 'succeeded', finishedAt: new Date().toISOString(), result: next.content, model: next.model, finishReason: next.finishReason } }); guard();
              previousIteration = next.content; modelName = next.model;
              if (node.loop!.stopWhen && previousIteration.includes(node.loop!.stopWhen)) break;
            } catch (error) {
              guard();
              await checkpoint({ step: { ...iterationStep, status: 'failed', finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : '循环迭代失败。' } });
              throw error;
            }
          }
          reply = { content: previousIteration, model: modelName ?? 'unknown', finishReason: 'stop' };
        } else {
          reply = await model({ title: node.title, instruction: node.text, sourceName: '工作流所选输入与前置步骤.json', sourceContent: context }, node);
        }
        guard();
        const content = normalizeDocumentMarkdown(reply.content);
        finishReason = reply.finishReason; modelName = reply.model;
        artifact = { id: crypto.randomUUID(), taskId, kind: 'markdown', version: 1, name: node.title.replace(/[<>:"/\\|?*]/g, '_') + '.md',
          mimeType: 'text/markdown', content, sha256: await sha256Text(content), createdAt: new Date().toISOString(), finishReason };
        result = documentExportContent(artifact);
      } else {
        const args = node.kind === 'inspect_csv' ? {} : node.kind === 'render_chart'
          ? { title: node.title, category_column: node.categoryColumn, value_columns: node.valueColumns, chart_type: node.chartType, unit: node.unit }
          : { title: node.title, markdown: [node.text, node.includeInputs && values.reference ? '\n## 参考材料\n\n' + values.reference : '',
            ...sources.map(source => '\n## ' + source.step + '\n\n' + source.output)].filter(Boolean).join('\n') };
        const executed = await executeOfficeTool({ id: step.id, type: 'function', function: { name: node.kind, arguments: JSON.stringify(args) } },
          { title: graph.name, instruction: '执行用户配置的工作流', csv: values.csv }, taskId, signal);
        artifact = executed.artifact;
        result = artifact?.kind === 'markdown' ? artifact.content : JSON.stringify(executed.result);
      }
      guard();
    } catch (error) {
      guard();
      await checkpoint({ step: { ...step, status: 'failed', finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : '步骤执行失败。' } });
      throw error;
    }
    await checkpoint({ step: { ...step, status: 'succeeded', finishedAt: new Date().toISOString(),
      result: artifact?.kind === 'markdown' ? JSON.stringify({ artifact_id: artifact.id, name: artifact.name, ...(finishReason ? { finishReason } : {}) }) : result,
      ...(modelName ? { model: modelName, finishReason } : {}),
      ...(artifact ? { outputArtifactId: artifact.id, outputName: artifact.name, outputSha256: artifact.sha256 } : {}) }, artifact }); guard();
    // Keep the partial artifact, but do not pass incomplete output into later nodes.
    if (finishReason && finishReason !== 'stop') throw new Error('模型未报告正常完成，成果已保留；请核对生成状态后重新运行，后续步骤未执行。');
    results.set(node.id, result);
  }
  return skipped.size ? `已按依赖顺序完成 ${graph.nodes.length} 个步骤（跳过 ${skipped.size} 个未命中的分支）。` : `已按依赖顺序完成 ${graph.nodes.length} 个步骤。`;
}
