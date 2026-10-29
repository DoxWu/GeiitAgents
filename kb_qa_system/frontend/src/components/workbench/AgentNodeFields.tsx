import type { AgentDefinition } from '@/agents/definition';
import { functionContract } from '@/workflows/functions';
import { nodeContract, type AgentInputBinding, WorkflowDefinition, WorkflowNode } from '@/workflows/definition';

export function AgentNodeFields({ node, definition, agents, onChange }: {
  node: WorkflowNode; definition: WorkflowDefinition; agents: AgentDefinition[]; onChange: (patch: Partial<WorkflowNode>) => void;
}) {
  function binding(key: string, patch: Partial<AgentInputBinding>) {
    const next = { ...(node.bindings?.[key] ?? { source: 'literal' as const, value: '' }), ...patch };
    if (next.source !== 'step') { delete next.nodeId; delete next.field; }
    onChange({ bindings: { ...node.bindings, [key]: next } });
  }
  const parents = definition.nodes.filter(item => nodeContract(item) && definition.edges.some(edge => edge.from === item.id && edge.to === node.id));
  const contract = node.kind === 'function' && node.fn ? functionContract(node.fn) : node.agent;
  return <div className="grid gap-3 sm:col-span-2">
    {node.kind !== 'function' && <label className="work-label">从私有仓库选择智能体<select className="work-input" value="" onChange={event => {
      const agent = agents.find(item => item.id === event.target.value);
      if (agent) {
        const copy = structuredClone(agent);
        if (node.kind === 'agent_condition' && !copy.outputFields.some(f => f.key === 'decision')) copy.outputFields = [{ key: 'decision', label: '判断结果', type: 'boolean', required: true, description: '条件成立返回true，否则false' }, ...copy.outputFields.slice(0, 9)];
        onChange({ agent: copy, title: agent.name.slice(0, 80), bindings: {} });
      }
    }}><option value="">{node.agent ? '替换 / 更新定义快照' : '请选择智能体'}</option>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>}
    {contract && <>
      <details className="border border-line p-3 text-sm"><summary>已选：{contract.name} · 查看指令与输出契约</summary><pre className="my-2 whitespace-pre-wrap">{contract.instructions}</pre><p>输出：{contract.outputFields.map(field => `${field.key} (${field.type}${field.required ? ', 必填' : ''})`).join('、')}</p></details>
      {contract.inputFields.map(field => {
        const value = node.bindings?.[field.key];
        return <fieldset key={field.key} className="grid gap-2 border border-line p-3 sm:grid-cols-2"><legend className="px-1 text-sm">{field.label} · {field.key} / {field.type}{field.required ? '（必填）' : ''}</legend>
          <label className="work-label">输入来源<select className="work-input" value={value?.source ?? ''} onChange={event => {
            if (!event.target.value) { const next = { ...node.bindings }; delete next[field.key]; onChange({ bindings: next }); }
            else binding(field.key, { source: event.target.value as AgentInputBinding['source'], value: field.type === 'boolean' ? 'false' : field.type === 'number' ? '0' : '' });
          }}><option value="">不传入</option><option value="literal">固定值</option>{field.type === 'string' && <><option value="reference">本次参考材料</option><option value="csv">本次 CSV</option><option value="previous">直接前置步骤完整结果</option></>}<option value="step">前置智能体 / 函数的输出字段</option></select></label>
          {value?.source === 'literal' && <label className="work-label">固定输入{field.type === 'boolean' ? <select className="work-input" value={value.value} onChange={event => binding(field.key, { value: event.target.value })}><option value="true">true</option><option value="false">false</option></select> : <textarea className="work-input" maxLength={50000} value={value.value} onChange={event => binding(field.key, { value: event.target.value })} />}</label>}
          {value?.source === 'step' && <label className="work-label">连入步骤的同类型字段<select className="work-input" value={JSON.stringify([value.nodeId ?? '', value.field ?? ''])} onChange={event => { const [nodeId, outputField] = JSON.parse(event.target.value) as string[]; binding(field.key, { nodeId, field: outputField }); }}><option value={'["",""]'}>先连入智能体，再选择字段</option>{parents.flatMap(parent => nodeContract(parent)?.outputFields.filter(output => output.type === field.type).map(output => <option key={`${parent.id}:${output.key}`} value={JSON.stringify([parent.id, output.key])}>{parent.title} → {output.label} ({output.key})</option>) ?? [])}</select></label>}
          {field.description && <p className="text-xs text-ink-secondary sm:col-span-2">{field.description}</p>}
        </fieldset>;
      })}
    </>}
    <p className="text-xs text-ink-secondary">步骤使用此处的定义快照；仓库后续修改不会自动改变已保存流程。共有智能体需先审阅并复制到私有仓库。</p>
  </div>;
}
