import { webcrypto } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { newWorkflow, newWorkflowNode, validateWorkflow } from './definition';
import { runWorkflow, WORKFLOW_SKIPPED_RESULT } from './runner';
import { evaluateIsolatedFunction } from './functionRuntime';
import { exportWorkflowDefinition, importWorkflowDefinition } from './portable';
vi.mock('./functions', async importOriginal => {
  const original = await importOriginal<typeof import('./functions')>();
  return {...original, executeWorkflowFunction: vi.fn(async (fn,inputs) => evaluateIsolatedFunction(fn.code,inputs))};
});
beforeEach(()=>vi.stubGlobal('crypto',webcrypto));afterEach(()=>vi.unstubAllGlobals());
it('passes typed outputs through a function decision while skipping the other path and trigger',async()=>{
  const a=newWorkflowNode('trigger',0),b=newWorkflowNode('function',1),yes=newWorkflowNode('function',2),no=newWorkflowNode('create_document',3),other=newWorkflowNode('trigger',4);
  b.functionBranch=true;b.fn!.reviewed=true;b.fn!.code='return { decision: true, result: inputs.context };';b.fn!.outputFields.push({key:'decision',label:'Decision',type:'boolean',required:true,description:''});b.bindings={context:{source:'reference',value:''}};
  yes.fn!.reviewed=true;yes.bindings={context:{source:'step',nodeId:b.id,field:'result',value:''}};
  const graph={...newWorkflow(),nodes:[a,b,yes,no,other],edges:[{from:a.id,to:b.id},{from:b.id,to:yes.id,when:'true' as const},{from:b.id,to:no.id,when:'false' as const}]};
  validateWorkflow(graph);const steps:Record<string,string>={};const model=vi.fn();
  await runWorkflow('fixture',graph,{reference:'value',csv:'',triggerNodeId:a.id},new AbortController().signal,model,async ({step})=>{steps[step.workflowNodeId!]=step.result!;});
  expect(JSON.parse(steps[yes.id])).toEqual({result:'value'});expect(steps[no.id]).toBe(WORKFLOW_SKIPPED_RESULT);expect(steps[other.id]).toBe(WORKFLOW_SKIPPED_RESULT);expect(model).not.toHaveBeenCalled();
  expect(importWorkflowDefinition(exportWorkflowDefinition(graph)).nodes.find(n=>n.kind==='function')?.fn?.reviewed).toBe(false);
});
