import { expect, it } from 'vitest';
import { autoLayoutWorkflow, newWorkflow, newWorkflowNode, validateWorkflow } from './definition';

it('lays out a DAG by dependency depth without changing graph data', () => {
  const source = newWorkflowNode('inspect_csv', 0), branch = newWorkflowNode('render_chart', 1), report = newWorkflowNode('create_document', 2);
  const definition = { ...newWorkflow(), nodes: [source, branch, report], edges: [{ from: source.id, to: branch.id }, { from: source.id, to: report.id }, { from: branch.id, to: report.id }] };
  const laid = autoLayoutWorkflow(definition);
  expect(laid.edges).toEqual(definition.edges); expect(laid.id).toBe(definition.id); expect(laid.nodes.map(node => node.id)).toEqual(definition.nodes.map(node => node.id));
  expect(laid.nodes.find(node => node.id === source.id)).toMatchObject({ x: 24, y: 24 });
  expect(laid.nodes.find(node => node.id === branch.id)).toMatchObject({ x: 304, y: 24 });
  expect(laid.nodes.find(node => node.id === report.id)).toMatchObject({ x: 584, y: 24 });
  expect(autoLayoutWorkflow(definition).nodes).toEqual(laid.nodes);
  expect(definition.nodes[1].x).toBe(274);
});

it('wraps maximum-length paths without overlapping parallel nodes or exceeding coordinate limits', () => {
  const nodes = Array.from({ length: 12 }, (_, i) => newWorkflowNode('create_document', i));
  const chain = nodes.slice(0, 10), edges = chain.slice(1).map((node, index) => ({ from: chain[index].id, to: node.id }));
  const laid = autoLayoutWorkflow({ ...newWorkflow(), nodes, edges });
  expect(() => validateWorkflow(laid)).not.toThrow();
  expect(laid.nodes[7].y).toBeGreaterThan(laid.nodes[10].y);
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = laid.nodes[i], b = laid.nodes[j];
    expect(Math.abs(a.x - b.x) >= 250 || Math.abs(a.y - b.y) >= 135).toBe(true);
  }
  const independent = autoLayoutWorkflow({ ...newWorkflow(), nodes, edges: [] });
  expect(independent.nodes.at(-1)?.y).toBe(1894);
  expect(() => validateWorkflow(independent)).not.toThrow();
});

it('keeps disconnected nodes in a stable vertical band and rejects cyclic graphs', () => {
  const first = newWorkflowNode('inspect_csv', 0), second = newWorkflowNode('create_document', 1);
  const definition = { ...newWorkflow(), nodes: [first, second], edges: [] };
  const laid = autoLayoutWorkflow(definition);
  expect(laid.nodes.map(node => [node.x, node.y])).toEqual([[24, 24], [24, 194]]);
  expect(() => autoLayoutWorkflow({ ...definition, edges: [{ from: first.id, to: second.id }, { from: second.id, to: first.id }] })).toThrow('循环依赖');
});
