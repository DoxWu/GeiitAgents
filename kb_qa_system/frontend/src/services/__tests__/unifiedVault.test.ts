import { expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { Blob } from 'node:buffer';
import { TextDecoder, TextEncoder } from 'node:util';
import { exportVaultBackup, importVaultBackup } from '../vaultBackup';
import { newFunction } from '@/workflows/functions';
import { newWorkflow, newWorkflowNode } from '@/workflows/definition';
import { newAgent } from '@/agents/definition';
import { newCompositionShape } from '@/officeTasks/composition';
import { vaultBackupFixture } from '@/test/vaultBackupFixture';

it('roundtrips capability snapshots, function review, composition and invocation checkpoints', async () => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('Blob', Blob); vi.stubGlobal('TextEncoder', TextEncoder); vi.stubGlobal('TextDecoder', TextDecoder);
  try {
    const data = await vaultBackupFixture(), fn = { ...newFunction(), reviewed: true };
    const resource = { id: crypto.randomUUID(), name: 'Trim', kind: 'tool' as const, version: 1, content: '', description: '', fn };
    const agent = { ...newAgent(), instructions: 'Use bound capabilities', capabilities: [resource] };
    const node = { ...newWorkflowNode('agent', 0), agent, bindings: { context: { source: 'reference' as const, value: '' } } };
    const workflow = { ...newWorkflow(), revision: 1, nodes: [node] }, taskId = crypto.randomUUID(), main = crypto.randomUUID(), call = crypto.randomUUID(), now = new Date().toISOString();
    data.capabilities = [resource]; data.agents = [agent]; data.workflows = [workflow];
    data.imageDraft = { prompt: 'Synthetic composition', references: [], shapes: [{ ...newCompositionShape(0), rotation: 45, layer: 7 }] };
    data.imageTasks = [{ id: 'isolated-image', name: '图片任务', updatedAt: now, draft: { ...data.imageDraft, canvas: { width: 864, height: 1536, background: '#aabbcc' } } }];
    data.taskRuns!.push({ id: taskId, type: 'workflow.run', workflow: { definition: workflow, input: { reference: 'fixture', csv: '' } }, title: 'Audit fixture', profileId: '', instruction: '', status: 'succeeded', createdAt: now, updatedAt: now, toolRunIds: [main, call], artifactIds: [] });
    data.toolRuns!.push({ id: main, taskId, workflowNodeId: node.id, tool: 'model.complete', status: 'succeeded', startedAt: now, finishedAt: now, finishReason: 'stop', result: '{"result":"ok"}' },
      { id: call, taskId, workflowNodeId: node.id, callId: crypto.randomUUID(), tool: 'agent.capability', arguments: JSON.stringify({ resourceId: resource.id, kind: 'tool' }), status: 'succeeded', startedAt: now, finishedAt: now });
    const backup = await exportVaultBackup(data, 'fixture-only');
    const restored = await importVaultBackup(backup.file, 'fixture-only');
    expect(restored.summary).toMatchObject({ capabilities: 1, hasImageDraft: true });
    expect(restored.data.capabilities).toEqual(data.capabilities); expect(restored.data.imageDraft).toEqual(data.imageDraft);
    expect(restored.data.imageTasks).toEqual(data.imageTasks);
    expect(restored.data.toolRuns?.find(tool => tool.id === call)).toEqual(data.toolRuns.find(tool => tool.id === call));
  } finally { vi.unstubAllGlobals(); }
});
