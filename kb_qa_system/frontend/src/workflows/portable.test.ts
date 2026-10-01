import { expect, it } from 'vitest';
import { newWorkflow, newWorkflowNode } from './definition';
import { exportWorkflowDefinition, importWorkflowDefinition, MAX_WORKFLOW_FILE_BYTES } from './portable';

it('roundtrips a portable definition with fresh local IDs and without model connection bindings', () => {
  const source = newWorkflowNode('generate_document', 0), target = newWorkflowNode('create_document', 1);
  source.profileId = 'machine-specific-secret-route';
  const saved = { ...newWorkflow(), name: '季度报告', revision: 4, nodes: [source, target], edges: [{ from: source.id, to: target.id }] };
  const encoded = exportWorkflowDefinition(saved);
  expect(encoded).not.toContain('machine-specific-secret-route');
  const imported = importWorkflowDefinition(encoded);
  expect(imported).toMatchObject({ name: saved.name, revision: 0 });
  expect(imported.id).not.toBe(saved.id);
  expect(imported.nodes.map(node => node.id)).not.toEqual(saved.nodes.map(node => node.id));
  expect(imported.nodes[0].profileId).toBeUndefined();
  expect(imported.edges[0]).toEqual({ from: imported.nodes[0].id, to: imported.nodes[1].id });
});

it.each([
  ['invalid JSON', '{'],
  ['unknown envelope fields', JSON.stringify({ format: 'geiit-workflow-definition', version: 1, exportedAt: new Date().toISOString(), workflow: { name: 'x', nodes: [], edges: [] }, secret: 'x' })],
  ['unsupported version', JSON.stringify({ format: 'geiit-workflow-definition', version: 2, exportedAt: new Date().toISOString(), workflow: { name: 'x', nodes: [], edges: [] } })],
  ['invalid reference', JSON.stringify({ format: 'geiit-workflow-definition', version: 1, exportedAt: new Date().toISOString(), workflow: { name: 'x', nodes: [newWorkflowNode('inspect_csv', 0)], edges: [{ from: 'missing', to: 'missing' }] } })],
])('rejects %s before a definition can be saved', (_name, value) => {
  expect(() => importWorkflowDefinition(value)).toThrow();
});

it('rejects a cycle after remapping imported step identifiers', () => {
  const first = newWorkflowNode('inspect_csv', 0), second = newWorkflowNode('create_document', 1);
  const encoded = JSON.stringify({ format: 'geiit-workflow-definition', version: 1, exportedAt: new Date().toISOString(),
    workflow: { name: 'cycle', nodes: [first, second], edges: [{ from: first.id, to: second.id }, { from: second.id, to: first.id }] } });
  expect(() => importWorkflowDefinition(encoded)).toThrow('循环依赖');
});

it('enforces the byte limit on portable input and output', () => {
  expect(() => importWorkflowDefinition(' '.repeat(MAX_WORKFLOW_FILE_BYTES + 1))).toThrow('512 KiB');
  const workflow = { ...newWorkflow(), name: 'oversized', nodes: Array.from({ length: 12 }, (_, index) => newWorkflowNode('create_document', index)) };
  workflow.nodes.forEach(node => { node.text = 'x'.repeat(50000); });
  expect(() => exportWorkflowDefinition(workflow)).toThrow('512 KiB');
});
