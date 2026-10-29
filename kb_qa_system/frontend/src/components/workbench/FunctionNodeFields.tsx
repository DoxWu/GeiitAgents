import { useEffect, useRef, useState } from 'react';
import { ACCOUNT_MODEL_ID, useWorkbenchStore } from '@/store/workbenchStore';
import { executeWorkflowFunction, validateFunction } from '@/workflows/functions';
import type { WorkflowNode } from '@/workflows/definition';
import { useWorkbenchFence } from '@/hooks/useWorkbenchFence';

export function FunctionNodeFields({ node, onChange }: { node: WorkflowNode; onChange: (patch: Partial<WorkflowNode>) => void }) {
  const store = useWorkbenchStore(), fn = node.fn!;
  const [profileId, setProfileId] = useState(''), [request, setRequest] = useState(''), [consent, setConsent] = useState(false);
  const [example, setExample] = useState('{"context":"示例文本"}'), [result, setResult] = useState(''), [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null), latest = useRef(fn); latest.current = fn;
  const capture = useWorkbenchFence();
  const profile = store.profiles.find(p => p.id === profileId), cloud = profileId === ACCOUNT_MODEL_ID || profile?.mode !== 'local';
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => { setConsent(false); }, [profileId, request]);
  function patch(value: Partial<typeof fn>) { onChange({ fn: { ...fn, ...value, reviewed: false }, capability: undefined }); setResult(''); }
  async function generate() {
    const current = capture(), original = JSON.stringify(fn); setBusy(true); setResult(''); const allowed = consent; setConsent(false);
    try {
      const id = await store.startDocumentTask(profileId, { title: '编写工作流函数', instruction: `编写同步纯 JavaScript 函数体，只能读取 inputs 并返回字段对象。无网络、文件、DOM、定时器、第三方库。只输出 JSON 对象，字段为 code、inputFields、outputFields。字段契约每项为 {key,label,type,required,description}，type 只能为 string/number/boolean。代码不超过20000字符。${node.functionBranch ? '输出必须包含必填 decision:boolean。' : ''}\n用户要求：${request}\n现有字段：${JSON.stringify({ inputFields: fn.inputFields, outputFields: fn.outputFields })}`, outputFormat: 'markdown' }, allowed);
      if (!current()) return;
      if (JSON.stringify(latest.current) !== original) throw new Error('函数已修改，生成结果保留在文档任务记录。');
      const task = useWorkbenchStore.getState().taskRuns.find(t => t.id === id), artifact = useWorkbenchStore.getState().artifacts.find(a => task?.artifactIds.includes(a.id));
      if (task?.status !== 'succeeded' || artifact?.finishReason !== 'stop') throw new Error('函数生成未完整完成。');
      const parsed = JSON.parse(artifact.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
      const next = validateFunction({ ...fn, code: parsed.code, inputFields: parsed.inputFields, outputFields: parsed.outputFields, version: fn.version + 1, reviewed: false });
      onChange({ fn: next, bindings: {}, capability: undefined }); setResult('已生成，请检查代码和字段、试运行，再确认用于流程。');
    } catch (reason) { if (current()) setResult(reason instanceof Error ? reason.message : '生成失败。'); }
    finally { setBusy(false); }
  }
  async function test() {
    const current = capture(), controller = new AbortController(); active.current = controller; setBusy(true); setResult('');
    try { const output = await executeWorkflowFunction({ ...fn, reviewed: true }, JSON.parse(example), controller.signal); if (current()) setResult(JSON.stringify(output, null, 2)); }
    catch (reason) { if (current()) setResult(reason instanceof Error ? reason.message : '试运行失败。'); }
    finally { active.current = null; setBusy(false); }
  }
  return <div className="grid gap-3 sm:col-span-2" aria-label="函数节点编辑器">
    {store.capabilities.some(r => r.kind === 'tool') && <label className="work-label">从工具仓库选取函数<select className="work-input" value="" onChange={e => { const resource = store.capabilities.find(r => r.id === e.target.value); if (resource?.fn) onChange({ fn: { ...structuredClone(resource.fn), reviewed: false }, capability: structuredClone(resource), bindings: {} }); }}><option value="">选择固定版本并检查</option>{store.capabilities.filter(r => r.kind === 'tool').map(r => <option key={r.id} value={r.id}>{r.name} · v{r.version}</option>)}</select></label>}
    <p className="text-xs text-ink-secondary">独立环境运行：1 秒计算、16 MiB 内存上限；只处理传入字段，无法访问网络、文件、应用或凭据。</p>
    <label className="work-label">函数名称<input className="work-input" value={fn.name} maxLength={100} onChange={e => patch({ name: e.target.value })} /></label>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(node.functionBranch)} onChange={e => onChange({ functionBranch: e.target.checked, fn: { ...fn, reviewed: false } })} />作为判断节点（需要 decision: boolean 输出）</label>
    <label className="work-label">JavaScript 函数体<textarea aria-label="函数代码" className="work-input min-h-40 font-mono" maxLength={20000} value={fn.code} onChange={e => patch({ code: e.target.value })} spellCheck={false} /></label>
    {(['inputFields', 'outputFields'] as const).map(key => <label key={key} className="work-label">{key === 'inputFields' ? '输入字段契约' : '输出字段契约'}（JSON）<textarea key={JSON.stringify(fn[key])} aria-label={key === 'inputFields' ? '函数输入契约' : '函数输出契约'} className="work-input min-h-24 font-mono" defaultValue={JSON.stringify(fn[key], null, 2)} onBlur={e => { try { patch(validateFunction({ ...fn, [key]: JSON.parse(e.target.value), reviewed: false })); } catch (reason) { setResult(reason instanceof Error ? reason.message : '字段 JSON 无效。'); } }} /></label>)}
    <details className="border border-line p-3"><summary>让智能体编写函数</summary><div className="mt-3 grid gap-3"><label className="work-label">函数用途<textarea className="work-input" value={request} maxLength={3000} onChange={e => setRequest(e.target.value)} /></label><label className="work-label">编写模型<select className="work-input" value={profileId} onChange={e => setProfileId(e.target.value)}><option value="">选择模型</option>{store.profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}{store.accountModel && <option value={ACCOUNT_MODEL_ID}>账号云端模型</option>}</select></label>{cloud && <label className="flex gap-2 text-sm"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />允许本次发送函数要求和字段契约</label>}<button type="button" className="work-command" disabled={busy || !profileId || !request.trim() || cloud && !consent} onClick={() => void generate()}>生成函数代码</button></div></details>
    <label className="work-label">试运行输入（JSON）<textarea className="work-input font-mono" value={example} onChange={e => setExample(e.target.value)} maxLength={100000} /></label>
    <div className="flex flex-wrap gap-2"><button type="button" className="work-command" disabled={busy} onClick={() => void test()}>隔离试运行</button>{busy && <button type="button" className="work-command" onClick={() => active.current?.abort()}>停止试运行</button>}<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={fn.reviewed} disabled={busy} onChange={e => onChange({ fn: { ...fn, reviewed: e.target.checked } })} />已检查代码与契约，允许流程调用</label></div>
    {result && <pre role="status" className="max-h-64 overflow-auto whitespace-pre-wrap break-words border border-line bg-muted p-3 text-xs">{result}</pre>}
  </div>;
}
