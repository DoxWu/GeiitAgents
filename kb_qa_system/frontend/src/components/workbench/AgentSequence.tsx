import { useEffect, useRef, useState } from 'react';
import { ACCOUNT_MODEL_ID, useWorkbenchStore } from '@/store/workbenchStore';
import { maxWorkflowModelRequests, newWorkflow, newWorkflowNode, pruneAgentStepBindings, type WorkflowDefinition } from '@/workflows/definition';
import { AgentNodeFields } from './AgentNodeFields';
import { Hint } from './Hint';

export function AgentSequence() {
  const store = useWorkbenchStore();
  const [graph, setGraph] = useState<WorkflowDefinition>(newWorkflow);
  const [reference, setReference] = useState(''), [profileId, setProfileId] = useState('');
  const [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [runId, setRunId] = useState('');
  const active = useRef(false);
  const chosen = profileId || store.profiles[0]?.id || (store.accountModel ? ACCOUNT_MODEL_ID : '');
  const profile = store.profiles.find(item => item.id === chosen);
  const cloud = graph.nodes.some(n => n.agent?.capabilities?.some(r => r.kind === 'mcp')) || chosen === ACCOUNT_MODEL_ID || profile?.mode === 'direct' || profile?.mode === 'relay';
  const run = store.taskRuns.find(item => item.id === runId);
  const signature = JSON.stringify([profile, store.accountModel]);
  useEffect(() => { setConsent(false); }, [signature]);
  useEffect(() => { if (!store.unlocked) { setGraph(newWorkflow()); setReference(''); setConsent(false); } }, [store.unlocked]);
  function change(next: WorkflowDefinition) { setGraph(next); setConsent(false); setError(''); }
  function removeStep(id: string) {
    const nodes = graph.nodes.filter(item => item.id !== id);
    const edges = nodes.slice(1).map((item, index) => ({ from: nodes[index].id, to: item.id }));
    change(pruneAgentStepBindings({ ...graph, nodes, edges }));
  }
  async function start() {
    if (active.current) return;
    active.current = true; setBusy(true); setError('');
    const allowed = consent; setConsent(false);
    try {
      const saved = await store.saveWorkflow({ ...graph, name: graph.name === '新工作流' ? '智能体顺序任务' : graph.name });
      setGraph(saved);
      const id = await store.startWorkflow(saved.id, saved.revision, { reference, csv: '' }, chosen, allowed, undefined, setRunId);
      setRunId(id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '智能体顺序任务失败。'); }
    finally { active.current = false; setBusy(false); }
  }
  return <details className="my-5 border border-line p-4"><summary className="cursor-pointer font-medium">使用仓库智能体编排多步骤任务</summary><div className="mt-4 grid gap-3">
    <div><Hint label="智能体顺序任务">按顺序添加 1–6 个智能体，每步明确选择输入字段。流程会保存到可视化工作流中，可继续编辑、查看历史或续跑。</Hint></div>
    <fieldset disabled={busy} className="grid min-w-0 gap-3">
      <label className="work-label">任务名称<input className="work-input" value={graph.name} maxLength={100} onChange={event => change({ ...graph, name: event.target.value })} /></label>
      {graph.nodes.map((node, index) => <section key={node.id} className="grid gap-3 border border-line p-3"><div className="flex items-center justify-between"><h3 className="text-sm font-medium">{index + 1}. {node.title}</h3><button className="work-command" onClick={() => removeStep(node.id)}>移除此步骤</button></div>
        <AgentNodeFields node={node} definition={graph} agents={store.agents} onChange={patch => change({ ...graph, nodes: graph.nodes.map(item => item.id === node.id ? { ...item, ...patch } : item) })} />
      </section>)}
      <button className="work-command justify-self-start" disabled={graph.nodes.length >= 6} onClick={() => { const next = newWorkflowNode('agent', graph.nodes.length), previous = graph.nodes.at(-1); change({ ...graph, nodes: [...graph.nodes, next], edges: [...graph.edges, ...(previous ? [{ from: previous.id, to: next.id }] : [])] }); }}>添加仓库智能体步骤</button>
      <label className="work-label">本次参考材料<textarea className="work-input min-h-24" value={reference} maxLength={50000} onChange={event => { setReference(event.target.value); setConsent(false); }} /></label>
      <label className="work-label">智能体执行模型<select className="work-input" value={chosen} onChange={event => { setProfileId(event.target.value); setConsent(false); }}><option value="">选择模型</option>{store.profiles.map(item => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}{store.accountModel && <option value={ACCOUNT_MODEL_ID}>账号云端模型</option>}</select></label>
      {graph.nodes.flatMap(node => node.agent?.capabilities ?? []).filter(resource => resource.kind === 'mcp').map((resource,index) => <div key={resource.id+index}><Hint label={'MCP 工具 ' + resource.name}>MCP：{resource.name} · {resource.transport === 'stdio' ? resource.localPackage?.name + '@' + resource.localPackage?.version : resource.endpoint} · {resource.toolName}；会发送映射输入，可能产生外部操作。</Hint></div>)}
      {cloud && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />允许本次将所选智能体指令、映射输入和前置结果发送到云端模型，并允许绑定的MCP服务按映射输入执行（最多 {maxWorkflowModelRequests(graph.nodes)} 次模型请求，可能计费）</label>}
      <button className="work-command justify-self-start bg-brand text-white" disabled={!graph.nodes.length || !chosen || !store.unlocked || cloud && !consent} onClick={() => void start()}>保存并运行智能体任务</button>
    </fieldset>
    {run && <section className="grid gap-2 text-sm" aria-label="智能体顺序任务结果"><p>{run.title} · {run.status}</p>{run.error && <p className="text-danger">{run.error}</p>}{run.status === 'running' && <button className="work-command justify-self-start" onClick={() => store.cancelTask(run.id)}>停止智能体任务</button>}{run.toolRunIds.map(id => store.toolRuns.find(item => item.id === id)).filter(Boolean).map(step => <details key={step!.id}><summary>{run.workflow?.definition.nodes.find(item => item.id === step!.workflowNodeId)?.title} · {step!.status}</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">{step!.result || step!.error}</pre></details>)}</section>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </div></details>;
}
