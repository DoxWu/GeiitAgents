import { webcrypto } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { newAgent } from './definition';
import { newFunction } from '@/workflows/functions';
import { runAgent } from './runtime';
import { executeWorkflowFunction } from '@/workflows/functions';
import { verifyCapability } from '@/api/capabilities';
vi.mock('@/workflows/functions', async original => ({...await original<typeof import('@/workflows/functions')>(),executeWorkflowFunction:vi.fn(async()=>({result:'trimmed'}))}));
vi.mock('@/api/capabilities',()=>({verifyCapability:vi.fn(async r=>r),callMcp:vi.fn()}));
beforeEach(()=>{vi.clearAllMocks();vi.stubGlobal('crypto',webcrypto);vi.mocked(verifyCapability).mockImplementation(async r=>r);});afterEach(()=>vi.unstubAllGlobals());
it('runs only a bound capability and then validates the final result',async()=>{
  const agent=newAgent();agent.instructions='Use tool';const fn={...newFunction(),reviewed:true};
  agent.capabilities=[{id:crypto.randomUUID(),name:'Trim',kind:'tool',version:1,description:'',content:'',fn}];
  const request=vi.fn().mockResolvedValueOnce({content:JSON.stringify({$tool:{id:agent.capabilities[0].id,inputs:{context:'text'}}}),finishReason:'stop',model:'fixture'}).mockResolvedValueOnce({content:'{"result":"done"}',finishReason:'stop',model:'fixture'});
  expect((await runAgent(agent,{context:'text'},new AbortController().signal,request)).content).toContain('done');expect(request).toHaveBeenCalledTimes(2);
  request.mockResolvedValue({content:'{"$tool":{"id":"unbound","inputs":{}}}',finishReason:'stop',model:'fixture'});
  await expect(runAgent(agent,{context:'text'},new AbortController().signal,request)).rejects.toThrow('未绑定');
});
it('stops at a bounded tool budget',async()=>{
  const agent=newAgent();agent.instructions='Use tool';agent.capabilities=[{id:crypto.randomUUID(),name:'Trim',kind:'tool',version:1,description:'',content:'',fn:{...newFunction(),reviewed:true}}];
  const request=vi.fn().mockResolvedValue({content:JSON.stringify({$tool:{id:agent.capabilities[0].id,inputs:{context:'text'}}}),finishReason:'stop',model:'fixture'});
  await expect(runAgent(agent,{context:'x'},new AbortController().signal,request)).rejects.toThrow('6次');expect(request).toHaveBeenCalledTimes(7);
});
it('persists intent before a capability executes and stops if checkpoint storage fails',async()=>{
  const agent={...newAgent(),instructions:'Use tool'};
  agent.capabilities=[{id:crypto.randomUUID(),name:'Trim',kind:'tool',version:1,description:'',content:'',fn:{...newFunction(),reviewed:true}}];
  const request=vi.fn().mockResolvedValue({content:JSON.stringify({$tool:{id:agent.capabilities[0].id,inputs:{context:'x'}}}),finishReason:'stop',model:'fixture'});
  const checkpoint=vi.fn().mockRejectedValue(new Error('storage unavailable'));
  await expect(runAgent(agent,{context:'x'},new AbortController().signal,request,false,checkpoint)).rejects.toThrow('storage unavailable');
  expect(executeWorkflowFunction).not.toHaveBeenCalled();expect(checkpoint).toHaveBeenCalledWith(agent.capabilities[0].id,'started');
});
it('rejects a final result when a shared capability is withdrawn during the model request',async()=>{
  const agent={...newAgent(),instructions:'Summarize'};
  agent.capabilities=[{id:crypto.randomUUID(),name:'Skill',kind:'skill',version:1,description:'',content:'Use evidence'}];
  const request=vi.fn(async()=>{vi.mocked(verifyCapability).mockRejectedValue(new Error('withdrawn'));return {content:'{"result":"done"}',finishReason:'stop' as const,model:'fixture'};});
  await expect(runAgent(agent,{context:'x'},new AbortController().signal,request)).rejects.toThrow('withdrawn');
});
