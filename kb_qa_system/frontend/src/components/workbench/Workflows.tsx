import { useEffect, useRef, useState } from 'react';
import { Download, FileUp } from 'lucide-react';
import { ACCOUNT_MODEL_ID, useWorkbenchStore } from '@/store/workbenchStore';
import { NODE_LABELS, newWorkflow, newWorkflowNode, validateWorkflow, type WorkflowConditionOperator, type WorkflowConditionSource, type WorkflowDefinition, type WorkflowInput, type WorkflowNode, type WorkflowNodeKind } from '@/workflows/definition';
import { WorkflowCanvas } from './WorkflowCanvas';
import { ToolArtifact } from './ToolArtifact';
import { GenerationPreview } from './GenerationPreview';
import { finishLabel } from '@/services/modelStream';
import type { TaskStatus } from '@/types/workbench';
import { exportWorkflowDefinition, importWorkflowDefinition, MAX_WORKFLOW_FILE_BYTES } from '@/workflows/portable';

const statuses: Record<TaskStatus, string> = { running: '运行中', succeeded: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
const RUNS_PER_PAGE = 10;
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export function Workflows() {
  const store = useWorkbenchStore();
  const [draft, setDraft] = useState<WorkflowDefinition>(() => clone(store.workflowDraft ?? newWorkflow())), [dirty, setDirty] = useState(Boolean(store.workflowDraft)), [selected, setSelected] = useState('');
  const stageDraft = store.stageWorkflowDraft ?? (() => true);
  const clearDraft = store.clearWorkflowDraft ?? (async () => {});
  const [input, setInput] = useState<WorkflowInput>({ reference: '', csv: '' });
  const [inputSheet, setInputSheet] = useState('');
  const [inputError, setInputError] = useState('');
  const [draftPending, setDraftPending] = useState(false);
  const [from, setFrom] = useState(''), [to, setTo] = useState(''), [edgeWhen, setEdgeWhen] = useState<'' | 'true' | 'false'>(''), [profileId, setProfileId] = useState('');
  const [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [resumeConsent, setResumeConsent] = useState(false);
  const [selectedRun, setSelectedRun] = useState(''), [artifactId, setArtifactId] = useState(''), [runsPage, setRunsPage] = useState(1);
  const mounted = useRef(false), starting = useRef(false), dirtyRef = useRef(false), inputGeneration = useRef(0), inputFile = useRef<HTMLInputElement>(null);
  const workflowFile = useRef<HTMLInputElement>(null);
  dirtyRef.current = dirty && (draftPending || store.workflowDraftSaving || Boolean(store.storageError));
  useEffect(() => {
    mounted.current = true;
    const warn = (event: BeforeUnloadEvent) => { if (dirtyRef.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => { mounted.current = false; window.removeEventListener('beforeunload', warn); };
  }, []);
  const chosen = profileId || store.profiles[0]?.id || (store.accountModel ? ACCOUNT_MODEL_ID : '');
  const usesModel = draft.nodes.some(n => n.kind === 'generate_document');
  const needsDefault = draft.nodes.some(n => n.kind === 'generate_document' && !n.profileId);
  const routeId = (node: WorkflowNode) => node.profileId || chosen;
  const routes = draft.nodes.filter(n => n.kind === 'generate_document').map(n => [n.id, routeId(n), store.profiles.find(p => p.id === routeId(n)), store.accountModel]);
  const cloud = routes.some(([, id, profile]) => id === ACCOUNT_MODEL_ID || (profile as typeof store.profiles[number] | undefined)?.mode === 'relay');
  const signature = JSON.stringify([routes, store.accountModel]);
  useEffect(() => { setConsent(false); }, [signature]);
  const node = draft.nodes.find(n => n.id === selected);
  const runs = store.taskRuns.filter(t => t.type === 'workflow.run');
  const runsPageCount = Math.max(1, Math.ceil(runs.length / RUNS_PER_PAGE));
  const currentRunsPage = Math.min(runsPage, runsPageCount);
  const pageRuns = runs.slice((currentRunsPage - 1) * RUNS_PER_PAGE, currentRunsPage * RUNS_PER_PAGE);
  const run = pageRuns.find(t => t.id === selectedRun) ?? pageRuns[0];
  const runNeedsCloud = Boolean(run?.workflow?.definition.nodes.some(n => {
    if (n.kind !== 'generate_document') return false;
    const id = n.profileId || run.profileId;
    return id === ACCOUNT_MODEL_ID || store.profiles.find(p => p.id === id)?.mode === 'relay';
  }));
  const resumeSignature = JSON.stringify([run?.id, run?.workflow, run?.profileId, store.profiles, store.accountModel]);
  useEffect(() => { setResumeConsent(false); }, [resumeSignature]);
  const artifact = store.artifacts.find(a => a.id === artifactId && run?.artifactIds.includes(a.id)) ?? store.artifacts.find(a => run?.artifactIds.includes(a.id));
  function change(next: WorkflowDefinition) { setDraft(next); setDirty(true); setDraftPending(stageDraft(next) === false); setConsent(false); setNotice(''); }
  function patchNode(id: string, patch: Partial<WorkflowNode>) { change({ ...draft, nodes: draft.nodes.map(n => n.id === id ? { ...n, ...patch } : n) }); }
  async function importInputFile(file?: File) {
    if (!file) return;
    const epoch = ++inputGeneration.current;
    try {
      if (!file.size) throw new Error('请选择非空 CSV 或 XLSX 文件。');
      let csv: string, sheetName = '';
      if (/\.csv$/i.test(file.name)) {
        if (file.size > 400000) throw new Error('CSV 文件不能超过 400 KB。');
        csv = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      } else if (/\.xlsx$/i.test(file.name)) {
        if (file.size > 2_000_000) throw new Error('XLSX 文件不能超过 2 MB。');
        const { parseFirstXlsxSheet } = await import('@/officeTasks/xlsx');
        const parsed = await parseFirstXlsxSheet(await file.arrayBuffer());
        csv = parsed.csv; sheetName = parsed.sheetName;
      } else throw new Error('仅支持 UTF-8 CSV 或 XLSX 文件。');
      if (!mounted.current || epoch !== inputGeneration.current) return;
      const { parseChartCsv } = await import('@/officeTasks/chart');
      parseChartCsv(csv);
      if (!mounted.current || epoch !== inputGeneration.current) return;
      setInput(current => ({ ...current, csv })); setInputSheet(sheetName); setInputError(''); setConsent(false);
    } catch (e) {
      if (mounted.current && epoch === inputGeneration.current) setInputError(e instanceof Error ? e.message : '无法读取 CSV 或 XLSX 文件。');
    }
  }
  async function importDefinition(file?: File) {
    if (!file) return;
    try {
      if (!file.size || file.size > MAX_WORKFLOW_FILE_BYTES) throw new Error('工作流文件须为非空 JSON，且不能超过 512 KiB。');
      const imported = importWorkflowDefinition(await file.text());
      if (!mounted.current) return;
      if (dirty && !window.confirm('放弃当前未保存的工作流修改并载入文件？')) return;
      change(imported); setSelected(imported.nodes[0]?.id || ''); setFrom(''); setTo(''); setEdgeWhen(''); setNotice('定义已校验并载入本机草稿。节点模型连接已清除；保存后才能运行。'); setError('');
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : '无法导入工作流定义。'); }
  }
  function exportDefinition() {
    try {
      if (!draft.revision) throw new Error('请先保存工作流定义再导出。');
      const text = exportWorkflowDefinition(draft), url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `geiit-workflow-${draft.name.replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 64) || 'definition'}.json`; anchor.click(); URL.revokeObjectURL(url);
      setNotice('工作流定义已导出；节点模型连接不会写入文件。'); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : '无法导出工作流定义。'); }
  }
  function load(definition: WorkflowDefinition) {
    if (dirty && !window.confirm('放弃尚未保存的工作流修改？')) return;
    if (store.workflowDraft) void clearDraft().catch(e => { if (mounted.current) setError(e instanceof Error ? e.message : '无法清除工作流草稿。'); });
    setDraft(clone(definition)); setSelected(definition.nodes[0]?.id || ''); setDirty(false); setDraftPending(false); setFrom(''); setTo(''); setEdgeWhen(''); setConsent(false); setError(''); setNotice('');
  }
  async function save() {
    setBusy(true); setError('');
    try { const saved = await store.saveWorkflow(draft); if (mounted.current) { setDraft(clone(saved)); setDirty(false); setDraftPending(false); setNotice(`工作流已加密保存 · 修订 ${saved.revision}`); } }
    catch (e) {
      if (mounted.current) {
        // A storage failure can leave the valid new revision in memory. Keep it
        // editable and let retryStorage persist it without a second execution.
        const current = useWorkbenchStore.getState().workflows.find(d => d.id === draft.id);
        if (current && current.revision === draft.revision + 1 && JSON.stringify(current.nodes) === JSON.stringify(draft.nodes) && JSON.stringify(current.edges) === JSON.stringify(draft.edges) && current.name === draft.name.trim()) setDraft(clone(current));
        setError(e instanceof Error ? e.message : '保存失败。');
      }
    } finally { if (mounted.current) setBusy(false); }
  }
  function connect() {
    try { const next = { ...draft, edges: [...draft.edges, { from, to, ...(edgeWhen ? { when: edgeWhen } : {}) }] }; validateWorkflow(next); change(next); setEdgeWhen(''); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : '无法连接。'); }
  }
  async function start() {
    if (starting.current) return;
    starting.current = true; setError(''); setSelectedRun(''); setArtifactId(''); setRunsPage(1);
    const allowed = consent; setConsent(false);
    try { const id = await store.startWorkflow(draft.id, draft.revision, input, chosen, allowed); if (mounted.current) setSelectedRun(id); }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : '工作流执行失败。'); }
    finally { starting.current = false; }
  }
  async function resume(taskId: string, fromNodeId?: string) {
    if (starting.current) return;
    const source = runs.find(item => item.id === taskId);
    if (!source || source.status === 'running') return;
    if (runNeedsCloud && !resumeConsent) { setError('续跑云端步骤前请先确认本次授权。'); return; }
    starting.current = true; setError(''); setNotice('');
    const allowed = runNeedsCloud && resumeConsent; setResumeConsent(false);
    setSelectedRun(''); setArtifactId(''); setRunsPage(1);
    try {
      const id = await store.resumeWorkflow(taskId, fromNodeId, allowed);
      if (mounted.current) { setSelectedRun(id); setArtifactId(''); setNotice('已创建新的续跑记录；原运行记录和成果保持不变。'); }
    } catch (e) { if (mounted.current) { setSelectedRun(useWorkbenchStore.getState().taskRuns.find(t => t.resumedFromTaskId === taskId)?.id || taskId); setError(e instanceof Error ? e.message : '工作流续跑失败。'); } }
    finally { starting.current = false; }
  }
  return <section aria-label="可视化工作流" className="min-h-0 min-w-0 flex-1 overflow-auto p-4 sm:p-6"><div className="mx-auto max-w-6xl space-y-5">
    <div><h1 className="text-xl font-semibold">可视化工作流</h1><p className="mt-2 text-sm text-ink-secondary">把本次输入交给工具，连线将前置步骤结果交给后续文档步骤。手动运行，按依赖顺序串行执行；不自动发邮件或修改外部文件。</p></div>
    <div className="flex flex-wrap items-end gap-3">
      <label className="work-label min-w-0 flex-1">已保存工作流<select aria-label="已保存工作流" className="work-input" value={store.workflows.some(d => d.id === draft.id) ? draft.id : ''} disabled={busy} onChange={e => { const saved = store.workflows.find(d => d.id === e.target.value); if (saved) load(saved); }}><option value="">未保存</option>{store.workflows.map(d => <option key={d.id} value={d.id}>{d.name} · 修订 {d.revision}</option>)}</select></label>
      <button className="work-command" disabled={busy} onClick={() => load(newWorkflow())}>新建工作流</button>
      <button className="work-command" disabled={busy} onClick={() => workflowFile.current?.click()}><FileUp size={16} />导入定义</button>
      <input ref={workflowFile} hidden type="file" accept=".json,application/json" aria-label="选择工作流定义 JSON" onChange={e => { void importDefinition(e.target.files?.[0]); e.target.value = ''; }} />
      <button className="work-command" disabled={busy || !draft.revision} onClick={exportDefinition}><Download size={16} />导出定义</button>
      <button className="work-command" disabled={busy || !draft.revision} onClick={() => { if (window.confirm('删除此工作流定义？已运行任务与成果会保留。')) { setBusy(true); void store.removeWorkflow(draft.id, draft.revision).then(() => { if (mounted.current) { setDraft(newWorkflow()); setDirty(false); } }).catch(e => { if (mounted.current) setError(String(e.message)); }).finally(() => { if (mounted.current) setBusy(false); }); } }}>删除定义</button>
    </div>
    <fieldset disabled={busy} className="min-w-0 space-y-4">
      <label className="work-label">工作流名称<input className="work-input" maxLength={100} value={draft.name} onChange={e => change({ ...draft, name: e.target.value })} /></label>
      <div className="flex flex-wrap gap-2">{(Object.entries(NODE_LABELS) as [WorkflowNodeKind, string][]).map(([kind, label]) => <button key={kind} className="work-command" disabled={draft.nodes.length >= 12} onClick={() => { const next = newWorkflowNode(kind, draft.nodes.length); change({ ...draft, nodes: [...draft.nodes, next] }); setSelected(next.id); }}>添加{label}</button>)}</div>
      <WorkflowCanvas definition={draft} selected={selected} onSelect={setSelected} onMove={(id, x, y) => patchNode(id, { x, y })} />
      {node && <section className="grid min-w-0 gap-3 rounded border border-line p-4 sm:grid-cols-2" aria-label="步骤配置">
        <label className="work-label">步骤标题<input className="work-input" value={node.title} maxLength={80} onChange={e => patchNode(node.id, { title: e.target.value })} /></label>
        <button className="work-command justify-self-start self-end" onClick={() => { change({ ...draft, nodes: draft.nodes.filter(n => n.id !== node.id), edges: draft.edges.filter(e => e.from !== node.id && e.to !== node.id) }); setSelected(''); }}>删除步骤及连线</button>
        {node.kind === 'create_document' || node.kind === 'generate_document' ? <>
          {node.kind === 'generate_document' && <label className="work-label sm:col-span-2">此步骤模型连接<select aria-label="此步骤模型连接" className="work-input" value={node.profileId || ''} onChange={e => patchNode(node.id, { profileId: e.target.value || undefined })}><option value="">使用工作流默认模型 · {store.profiles.find(p => p.id === chosen)?.name || (chosen === ACCOUNT_MODEL_ID ? '账号云端模型' : '未选择')}</option>{store.profiles.map(p => <option key={p.id} value={p.id}>{p.name} · {p.model}</option>)}{store.accountModel && <option value={ACCOUNT_MODEL_ID}>账号云端模型 · {store.accountModel.model}</option>}</select></label>}
          <label className="work-label sm:col-span-2">{node.kind === 'generate_document' ? '步骤生成要求' : 'Markdown 正文'}<textarea aria-label={node.kind === 'generate_document' ? '步骤生成要求' : 'Markdown 正文'} className="work-input min-h-28" maxLength={node.kind === 'generate_document' ? 10000 : 50000} value={node.text} onChange={e => patchNode(node.id, { text: e.target.value })} /></label>
          <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={node.includeInputs} onChange={e => patchNode(node.id, { includeInputs: e.target.checked })} />{node.kind === 'generate_document' ? '包含本次参考材料与 CSV；连入的步骤结果也会发送给模型' : '附加本次参考材料；连入的步骤结果总会附加到正文'}</label>
        </> : node.kind === 'condition' ? <>
          <label className="work-label">条件来源<select aria-label="条件来源" className="work-input" value={node.condition?.source || 'reference'} onChange={e => patchNode(node.id, { condition: { source: e.target.value as WorkflowConditionSource, operator: node.condition?.operator || 'contains', value: node.condition?.value || '' } })}><option value="reference">本次参考材料</option><option value="csv">本次 CSV</option><option value="previous">直接前置步骤结果</option></select></label>
          <label className="work-label">条件操作<select aria-label="条件操作" className="work-input" value={node.condition?.operator || 'contains'} onChange={e => patchNode(node.id, { condition: { source: node.condition?.source || 'reference', operator: e.target.value as WorkflowConditionOperator, value: node.condition?.value || '' } })}><option value="contains">包含</option><option value="not_contains">不包含</option><option value="equals">等于</option><option value="not_equals">不等于</option><option value="exists">有内容</option><option value="not_exists">为空</option><option value="gt">数字大于</option><option value="gte">数字大于等于</option><option value="lt">数字小于</option><option value="lte">数字小于等于</option></select></label>
          <label className="work-label sm:col-span-2">比较值<input aria-label="条件比较值" className="work-input" maxLength={1000} value={node.condition?.value || ''} disabled={node.condition?.operator === 'exists' || node.condition?.operator === 'not_exists'} onChange={e => patchNode(node.id, { condition: { source: node.condition?.source || 'reference', operator: node.condition?.operator || 'contains', value: e.target.value } })} /></label>
          <p className="text-sm text-ink-secondary sm:col-span-2">条件步骤只产生 true 或 false；从条件步骤连出的每条线必须选择对应分支。</p>
        </> : node.kind === 'render_chart' ? <>
          <label className="work-label">分类列（从 1 开始）<input className="work-input" type="number" min={1} max={12} value={node.categoryColumn + 1} onChange={e => patchNode(node.id, { categoryColumn: Number(e.target.value) - 1 })} /></label>
          <label className="work-label">图表类型<select aria-label="图表类型" className="work-input" value={node.chartType} onChange={e => { const chartType = e.target.value as 'bar' | 'line' | 'pie'; patchNode(node.id, { chartType, ...(chartType === 'pie' ? { valueColumns: node.valueColumns.slice(0, 1) } : {}) }); }}><option value="bar">柱状图</option><option value="line">折线图</option><option value="pie">饼图</option></select></label>
          <fieldset className="sm:col-span-2"><legend className="mb-2 text-sm">数值列（{node.chartType === 'pie' ? '饼图选择 1 列' : '选择 1–6 列'}，从 1 开始）</legend><div className="flex flex-wrap gap-3">{Array.from({ length: 12 }, (_, i) => <label key={i} className="flex gap-1 text-sm"><input type="checkbox" checked={node.valueColumns.includes(i)} disabled={node.chartType === 'pie' && !node.valueColumns.includes(i)} onChange={e => patchNode(node.id, { valueColumns: e.target.checked ? [...node.valueColumns, i].sort((a, b) => a - b) : node.valueColumns.filter(v => v !== i) })} />{i + 1}</label>)}</div></fieldset>
          <label className="work-label">单位<input className="work-input" maxLength={20} value={node.unit} onChange={e => patchNode(node.id, { unit: e.target.value })} /></label>
        </> : <p className="text-sm text-ink-secondary">检查本次 CSV 的表头与数据；不会执行单元格公式。</p>}
      </section>}
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
        <label className="work-label">前置步骤<select aria-label="前置步骤" className="work-input" value={from} onChange={e => { const value = e.target.value; setFrom(value); if (draft.nodes.find(n => n.id === value)?.kind !== 'condition') setEdgeWhen(''); }}><option value="">请选择</option>{draft.nodes.map((n, i) => <option key={n.id} value={n.id}>{i + 1}. {n.title}</option>)}</select></label>
        <label className="work-label">后续步骤<select aria-label="后续步骤" className="work-input" value={to} onChange={e => setTo(e.target.value)}><option value="">请选择</option>{draft.nodes.map((n, i) => <option key={n.id} value={n.id}>{i + 1}. {n.title}</option>)}</select></label>
        {draft.nodes.find(n => n.id === from)?.kind === 'condition' ? <label className="work-label">分支值<select aria-label="分支值" className="work-input" value={edgeWhen} onChange={e => setEdgeWhen(e.target.value as '' | 'true' | 'false')}><option value="">请选择</option><option value="true">true</option><option value="false">false</option></select></label> : <span />}
        <button className="work-command self-end" disabled={!from || !to || draft.nodes.find(n => n.id === from)?.kind === 'condition' && !edgeWhen} onClick={connect}>连接步骤</button>
      </div>
      {!!draft.edges.length && <ul className="space-y-2">{draft.edges.map(e => <li key={e.from + ':' + e.to + ':' + (e.when || '')} className="flex flex-wrap items-center gap-2 text-sm"><span>{draft.nodes.find(n => n.id === e.from)?.title} {e.when ? `(${e.when})` : ''} → {draft.nodes.find(n => n.id === e.to)?.title}</span><button className="work-command" onClick={() => change({ ...draft, edges: draft.edges.filter(edge => edge !== e) })}>移除此连线</button></li>)}</ul>}
      <div className="flex flex-wrap items-center gap-3"><button className="work-command bg-brand text-white" onClick={() => void save()} disabled={!draft.nodes.length}>保存工作流</button><span className="text-sm text-ink-secondary">{draftPending ? '草稿字段暂时不完整，最后一个有效版本仍保留。' : store.workflowDraftSaving ? '正在加密保存本机草稿…' : store.storageError ? '本机草稿未确认保存，请检查存储后重试。' : dirty ? '修改已加密保存为本机草稿；点击“保存工作流”后才能运行。' : draft.revision ? `已保存修订 ${draft.revision}` : '尚未保存'} · 最多 12 个步骤 / 6 个模型步骤</span></div>
    </fieldset>
    <section aria-label="工作流运行输入" className="space-y-3 border-t border-line pt-4"><h2 className="font-semibold">本次运行输入</h2>
      <label className="work-label">工作流参考材料<textarea aria-label="工作流参考材料" className="work-input min-h-24" maxLength={50000} value={input.reference} onChange={e => { setInput({ ...input, reference: e.target.value }); setConsent(false); }} /></label>
      <label className="work-label">工作流 CSV<textarea aria-label="工作流 CSV" className="work-input min-h-24 font-mono" maxLength={100000} value={input.csv} onChange={e => { inputGeneration.current++; setInput({ ...input, csv: e.target.value }); setInputSheet(''); setInputError(''); setConsent(false); }} placeholder={'月份,销量\n一月,12\n二月,18'} /></label>
      <div className="flex flex-wrap items-center gap-2"><button type="button" className="work-command" onClick={() => inputFile.current?.click()}><FileUp size={16} />导入 CSV / XLSX</button><input ref={inputFile} hidden type="file" accept=".csv,.xlsx" aria-label="选择工作流 CSV 或 XLSX 文件" onChange={e => { void importInputFile(e.target.files?.[0]); e.target.value = ''; }} />{inputSheet && <span role="status" className="text-sm text-ink-secondary">工作表：{inputSheet}</span>}{inputError && <span role="alert" className="text-sm text-danger">{inputError}</span>}</div>
      <p className="text-xs text-ink-secondary">CSV 最多 50 行、12 列；输入随运行快照加密保存。节点不会读取其他文件。执行中可离开页签；锁库/关闭会中断，不自动重放。</p>
      {usesModel && <label className="work-label">工作流默认模型<select aria-label="工作流默认模型" className="work-input" value={chosen} onChange={e => { setProfileId(e.target.value); setConsent(false); }}><option value="">选择模型</option>{store.profiles.map(p => <option key={p.id} value={p.id}>{p.name} · {p.model}</option>)}{store.accountModel && <option value={ACCOUNT_MODEL_ID}>账号云端模型 · {store.accountModel.model}</option>}</select></label>}
      {cloud && <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />允许本次按已保存工作流向所选云端模型发送节点要求、所选输入与前置结果（最多 {draft.nodes.filter(n => n.kind === 'generate_document').length} 次模型请求，可能计费）</label>}
      <button className="work-command bg-brand text-white" disabled={busy || dirty || !draft.revision || Boolean(store.storageError) || needsDefault && !chosen || Boolean(cloud && !consent) || runs.some(r => r.status === 'running' && r.workflow?.definition.id === draft.id)} onClick={() => void start()}>手动运行工作流</button>
    </section>
    {notice && <p role="status" className="text-sm">{notice}</p>}{error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {store.storageError && <button className="work-command" onClick={() => void store.retryStorage().then(() => { if (mounted.current) { setNotice('本机保存已重试；页面未提交的修改仍需点击保存工作流。'); } }).catch(e => { if (mounted.current) setError(e.message); })}>重试本机保存</button>}
    <section aria-label="工作流运行历史" className="space-y-3 border-t border-line pt-4"><h2 className="font-semibold">运行历史</h2>
      <label className="work-label">选择工作流运行<select aria-label="选择工作流运行" className="work-input" value={run?.id || ''} onChange={e => { setSelectedRun(e.target.value); setArtifactId(''); }}>{!runs.length && <option value="">暂无记录</option>}{pageRuns.map(r => <option key={r.id} value={r.id}>{r.title} · 修订 {r.workflow?.definition.revision} · {statuses[r.status]} · {new Date(r.createdAt).toLocaleString()}</option>)}</select></label>
      {runs.length > RUNS_PER_PAGE && <nav aria-label="工作流运行历史分页" className="flex flex-wrap items-center gap-2 text-sm"><span>第 {currentRunsPage} / {runsPageCount} 页 · 共 {runs.length} 条</span><button className="work-command" disabled={currentRunsPage <= 1} onClick={() => { setRunsPage(currentRunsPage - 1); setSelectedRun(''); setArtifactId(''); }}>上一页运行</button><button className="work-command" disabled={currentRunsPage >= runsPageCount} onClick={() => { setRunsPage(currentRunsPage + 1); setSelectedRun(''); setArtifactId(''); }}>下一页运行</button></nav>}
      {run && <><p className="font-medium">{statuses[run.status]} · {run.artifactIds.length} 个成果</p>{run.error && <p className="text-sm text-danger">{run.error}</p>}{run.summary && <p className="text-sm">{run.summary}</p>}
        <div className="flex flex-wrap gap-2">{run.status === 'running' ? <button className="work-command" onClick={() => store.cancelTask(run.id)}>停止工作流</button> : <>
          {(run.status === 'failed' || run.status === 'interrupted' || run.status === 'cancelled') && <>
            {runNeedsCloud && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={resumeConsent} onChange={e => setResumeConsent(e.target.checked)} />确认续跑时重新向云端模型发送步骤内容</label>}
            <button className="work-command bg-brand text-white" onClick={() => void resume(run.id)}>从失败步骤继续</button>
          </>}
          <button className="work-command" onClick={() => { if (run.workflow) { if (dirty && !window.confirm('放弃尚未保存修改并复制历史快照？')) return; const copy = { ...clone(run.workflow.definition), id: crypto.randomUUID(), revision: 0, updatedAt: new Date().toISOString() }; setDraft(copy); setDirty(true); setInput(clone(run.workflow.input)); setProfileId(run.profileId); setConsent(false); setSelected(copy.nodes[0]?.id || ''); setNotice('已复制历史快照；保存后可作为新任务重新运行，可能再次计费。'); } }}>复制快照为新工作流</button>
          <button className="work-command" onClick={() => { if (window.confirm('删除本次运行和成果？工作流定义保留。')) void store.removeTask(run.id).catch(e => { if (mounted.current) setError(e.message); }); }}>删除运行</button>
        </>}</div>
        {run.status === 'running' && store.generationPreviews[run.id] && <GenerationPreview value={store.generationPreviews[run.id]} label="工作流模型生成预览" />}
        <ol className="space-y-2">{run.toolRunIds.map(id => store.toolRuns.find(t => t.id === id)).filter(Boolean).map(t => <li className="rounded border border-line p-3 text-sm" key={t!.id}><details><summary>{run.workflow?.definition.nodes.find(n => n.id === t!.workflowNodeId)?.title || t!.tool} · {statuses[t!.status]}</summary>{t!.warnings?.map((warning, i) => <p key={i}>{warning}</p>)}{t!.finishReason && <p>{finishLabel(t!.finishReason)}</p>}{t!.error && <p>{t!.error}</p>}{t!.result && <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">{t!.result}</pre>}</details>{t!.workflowNodeId && (t!.status === 'failed' || t!.status === 'interrupted' || t!.status === 'cancelled' || t!.finishReason && t!.finishReason !== 'stop') && run.status !== 'running' && <button className="work-command mt-2" onClick={() => void resume(run.id, t!.workflowNodeId)}>重试此步骤并继续</button>}</li>)}</ol>
        {!!run.artifactIds.length && <label className="work-label">选择工作流成果<select aria-label="选择工作流成果" className="work-input" value={artifact?.id || ''} onChange={e => setArtifactId(e.target.value)}>{store.artifacts.filter(a => run.artifactIds.includes(a.id)).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>}
        {artifact && <ToolArtifact key={artifact.id} artifact={artifact} running={run.status === 'running'} />}
      </>}
    </section>
  </div></section>;
}
