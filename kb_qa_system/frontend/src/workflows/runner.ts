import { executeOfficeTool, type ToolCheckpoint } from '@/officeTasks/toolRunner';
import { documentExportContent, normalizeDocumentMarkdown, sha256Text, type DocumentTaskInput } from '@/officeTasks/document';
import { checkChart, parseChartCsv } from '@/officeTasks/chart';
import type { FinishReason } from '@/services/modelStream';
import type { ToolRun, WorkArtifact } from '@/types/workbench';
import { validateWorkflow, validateWorkflowInput, workflowOrder, type WorkflowCondition, type WorkflowDefinition, type WorkflowInput, type WorkflowNode } from './definition';

export const WORKFLOW_SKIPPED_RESULT = '__geiit_workflow_skipped__';

export function evaluateWorkflowCondition(condition: WorkflowCondition, input: WorkflowInput, previous: string): boolean {
  const source = condition.source === 'reference' ? input.reference : condition.source === 'csv' ? input.csv : previous;
  if (condition.operator === 'exists') return source.trim().length > 0;
  if (condition.operator === 'not_exists') return source.trim().length === 0;
  if (condition.operator === 'contains') return source.includes(condition.value);
  if (condition.operator === 'not_contains') return !source.includes(condition.value);
  if (condition.operator === 'equals') return source === condition.value;
  if (condition.operator === 'not_equals') return source !== condition.value;
  const left = Number(source), right = Number(condition.value);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  if (condition.operator === 'gt') return left > right;
  if (condition.operator === 'gte') return left >= right;
  if (condition.operator === 'lt') return left < right;
  return left <= right;
}

function toolName(node: WorkflowNode): ToolRun['tool'] {
  return node.kind === 'condition' ? 'workflow.condition' : node.kind === 'generate_document' ? 'model.complete' : `office.${node.kind}`;
}

export interface WorkflowResumeOptions {
  completedResults?: Map<string, string>;
}

export function prepareWorkflow(definition: WorkflowDefinition, input: WorkflowInput) {
  const graph = validateWorkflow(definition), values = validateWorkflowInput(input);
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
      && (edge.when === undefined || results.get(edge.from) === edge.when));
    const active = !incoming.length ? true : incoming.some(edge => edge.when !== undefined) ? enabled.length > 0 : enabled.length === incoming.length;
    if (!active) {
      const now = new Date().toISOString();
      await checkpoint({ step: { id: crypto.randomUUID(), taskId, workflowNodeId: node.id, tool: toolName(node), status: 'succeeded', startedAt: now, finishedAt: now,
        result: WORKFLOW_SKIPPED_RESULT, warnings: ['条件分支未命中，步骤已跳过。'] } });
      guard(); results.set(node.id, WORKFLOW_SKIPPED_RESULT); skipped.add(node.id); continue;
    }
    const sources = enabled.map(e => ({ step: graph.nodes.find(n => n.id === e.from)!.title, output: results.get(e.from)! }));
    const context = JSON.stringify({ ...(node.includeInputs ? { reference: values.reference, csv: values.csv } : {}), previousSteps: sources });
    if (node.kind === 'generate_document' && context.length > 100000) throw new Error('前置步骤结果超过 100000 字符，请拆分工作流；不会静默截断。');
    const step: ToolRun = { id: crypto.randomUUID(), taskId, workflowNodeId: node.id, tool: toolName(node), status: 'running', startedAt: new Date().toISOString() };
    await checkpoint({ step }); guard();
    let artifact: WorkArtifact | undefined, result: string, modelName: string | undefined, finishReason: FinishReason | undefined;
    try {
      if (node.kind === 'condition') {
        result = String(evaluateWorkflowCondition(node.condition!, values, sources.map(source => source.output).join('\n')));
      } else if (node.kind === 'generate_document') {
        const reply = await model({ title: node.title, instruction: node.text, sourceName: '工作流所选输入与前置步骤.json', sourceContent: context }, node); guard();
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
