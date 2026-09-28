import { useEffect, useRef, useState } from 'react';
import { ACCOUNT_MODEL_ID, useWorkbenchStore } from '@/store/workbenchStore';
import { useAuthStore } from '@/store/authStore';
import type { OfficeToolInput } from '@/officeTasks/toolRunner';
import type { TaskStatus, WorkArtifact } from '@/types/workbench';
import { PrivateMarkdown } from './LocalMarkdown';

const statusText: Record<TaskStatus, string> = { running: '运行中', succeeded: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
const toolText: Record<string, string> = { 'model.tools': '请求模型', 'office.inspect_csv': '读取 CSV', 'office.render_chart': '生成图表', 'office.create_document': '创建文档', 'document.export-docx': '导出 Word' };
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ToolArtifact({ artifact, running }: { artifact: WorkArtifact; running: boolean }) {
  const [url, setUrl] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (artifact.kind !== 'svg') return;
    const value = URL.createObjectURL(new Blob([artifact.content], { type: artifact.mimeType })); setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [artifact]);
  async function docx() {
    setBusy(true); setError('');
    try {
      const result = await useWorkbenchStore.getState().exportArtifactDocx(artifact.id);
      if (mounted.current) { download(new Blob([result.bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), result.name); setError(result.warnings.join('；')); }
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : '导出失败。'); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <section aria-label="多步骤任务成果" className="mt-4 min-w-0 border-t border-line pt-4">
    <h3 className="break-all font-medium">{artifact.name}</h3>
    <div className="my-3 flex flex-wrap gap-2"><button className="work-command" onClick={() => download(new Blob([artifact.content], { type: artifact.mimeType }), artifact.name)}>下载成果</button>
      {artifact.kind === 'markdown' && <button className="work-command" disabled={busy || running} onClick={() => void docx()}>{busy ? '正在导出…' : '导出 Word'}</button>}</div>
    {error && <p role="status" className="text-sm">{error}</p>}
    {artifact.kind === 'markdown' ? <PrivateMarkdown content={artifact.content} /> : <div className="overflow-x-auto bg-white">{url && <img src={url} alt={artifact.name} className="max-w-none" />}</div>}
  </section>;
}

export function OfficeToolTasks() {
  const store = useWorkbenchStore(), userId = useAuthStore(s => s.isAuthenticated ? s.user?.id : undefined);
  const [input, setInput] = useState<OfficeToolInput>({ title: '', instruction: '', sourceContent: '', csv: '' });
  const [profileId, setProfileId] = useState(''), [allowCloud, setAllowCloud] = useState(false), [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(''), [selectedArtifact, setSelectedArtifact] = useState(''), [error, setError] = useState('');
  const mounted = useRef(false), starting = useRef(false), readVersion = useRef(0);
  useEffect(() => { const reads = readVersion; mounted.current = true; return () => { mounted.current = false; reads.current++; }; }, []);
  const chosen = profileId || store.profiles[0]?.id || (store.accountModel ? ACCOUNT_MODEL_ID : '');
  const chosenProfile = store.profiles.find(profile => profile.id === chosen);
  const cloud = chosen === ACCOUNT_MODEL_ID || chosenProfile?.mode === 'relay';
  useEffect(() => { setAllowCloud(false); }, [chosen, chosenProfile, userId, store.accountModel]);
  const tasks = store.taskRuns.filter(task => task.type === 'office.tools');
  const task = tasks.find(task => task.id === selected) || tasks[0];
  const artifacts = task ? task.artifactIds.map(id => store.artifacts.find(item => item.id === id)).filter((item): item is WorkArtifact => Boolean(item)) : [];
  const artifact = artifacts.find(item => item.id === selectedArtifact) || artifacts[0];
  function change(patch: Partial<OfficeToolInput>) { readVersion.current++; setInput(current => ({ ...current, ...patch })); setAllowCloud(false); setError(''); }
  async function open(file: File | undefined, kind: 'csv' | 'reference') {
    if (!file) return;
    const version = ++readVersion.current;
    try {
      if (!file.size || file.size > (kind === 'csv' ? 400000 : 200000) || !(kind === 'csv' ? /\.csv$/i : /\.(md|txt)$/i).test(file.name)) throw new Error('请选择规定类型与大小范围内的 UTF-8 文本文件。');
      const content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (!mounted.current || version !== readVersion.current) return;
      if (content.length > (kind === 'csv' ? 100000 : 50000)) throw new Error('文件文本超过长度限制。');
      change(kind === 'csv' ? { csv: content } : { sourceContent: content, sourceName: file.name });
    } catch (error) { if (mounted.current && version === readVersion.current) setError(error instanceof Error ? error.message : '无法读取文件。'); }
  }
  async function start() {
    if (starting.current) return;
    starting.current = true; readVersion.current++; setBusy(true); setError(''); setSelected('');
    const consent = allowCloud; setAllowCloud(false);
    try { const id = await store.startOfficeToolTask(chosen, input, consent); if (mounted.current) setSelected(id); }
    catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : '多步骤任务失败。'); }
    finally { starting.current = false; if (mounted.current) setBusy(false); }
  }
  return <section aria-label="多步骤办公任务" className="grid min-h-0 min-w-0 flex-1 grid-cols-1 md:grid-cols-[220px_minmax(0,1fr)]">
    <aside className="max-h-44 overflow-auto border-b border-line p-3 md:max-h-none md:border-b-0 md:border-r">
      <h2 className="mb-3 text-sm font-medium">多步骤任务记录</h2>
      {tasks.map(item => <button key={item.id} className={`mb-1 block w-full rounded p-2 text-left ${item.id === task?.id ? 'bg-muted' : ''}`} onClick={() => { setSelected(item.id); setSelectedArtifact(''); }}><span className="block truncate">{item.title}</span><span className="text-xs text-ink-secondary">{statusText[item.status]} · {item.artifactIds.length} 个成果</span></button>)}
    </aside>
    <div className="min-h-0 min-w-0 overflow-auto p-4 sm:p-6"><div className="mx-auto max-w-4xl">
      <h1 className="text-xl font-semibold">多步骤办公助手</h1>
      <p className="mt-2 text-sm text-ink-secondary">让模型按目标读取本次 CSV、生成图表和 Markdown 文档。所有成果保存到本机加密库，下载由你决定。需要模型支持工具调用；最多 6 轮模型请求、8 次工具执行，可随时停止。</p>
      <form className="mt-5 grid gap-3" onSubmit={event => { event.preventDefault(); void start(); }}>
        <fieldset disabled={busy} className="grid min-w-0 gap-3">
          <label className="work-label">任务标题<input className="work-input" required maxLength={100} value={input.title} onChange={e => change({ title: e.target.value })} /></label>
          <label className="work-label">办公目标<textarea className="work-input min-h-24" required maxLength={10000} placeholder="例如：检查销售 CSV，绘制趋势图，并生成带结论与待确认事项的汇报文档。" value={input.instruction} onChange={e => change({ instruction: e.target.value })} /></label>
          <label className="work-label">任务模型<select className="work-input" value={chosen} onChange={e => { setProfileId(e.target.value); setAllowCloud(false); }}><option value="" disabled>请选择模型</option>{store.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>)}{store.accountModel && <option value={ACCOUNT_MODEL_ID}>账号云端 · {store.accountModel.model}</option>}</select></label>
          <label className="work-label">参考材料（可选）<textarea className="work-input min-h-24" maxLength={50000} value={input.sourceContent || ''} onChange={e => change({ sourceContent: e.target.value, sourceName: undefined })} /></label>
          <label className="work-label">导入参考文件（MD/TXT，最多 200 KB）<input type="file" accept=".md,.txt" onChange={e => { void open(e.target.files?.[0], 'reference'); e.target.value = ''; }} /></label>
          <label className="work-label">任务 CSV（可选）<textarea className="work-input min-h-24 font-mono" maxLength={100000} value={input.csv || ''} onChange={e => change({ csv: e.target.value })} /></label>
          <label className="work-label">导入任务 CSV（最多 400 KB）<input type="file" accept=".csv" onChange={e => { void open(e.target.files?.[0], 'csv'); e.target.value = ''; }} /></label>
          <p className="text-xs text-ink-secondary">CSV 最多 50 行、12 列；图表支持 1–6 个同量纲数值系列。参考材料最多 50000 字符。运行期间关闭客户端或锁库会中断任务，已保存成果保留，不自动重放。</p>
          {cloud && <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={allowCloud} onChange={e => setAllowCloud(e.target.checked)} />允许本次最多 6 轮请求将目标、参考材料、CSV 工具结果和生成内容发给所选云端模型；可能计费。</label>}
          <button className="work-command justify-self-start bg-brand text-white" type="submit" disabled={!chosen || busy || Boolean(cloud && !allowCloud)}>{busy ? '任务运行中…' : '开始多步骤任务'}</button>
        </fieldset>
      </form>
      {error && <p role="alert" className="mt-4 text-sm text-danger">{error}</p>}
      {task && <section aria-label="多步骤任务详情" className="mt-6 min-w-0 border-t border-line pt-4">
        <h2 className="break-words text-lg font-medium">{task.title} · {statusText[task.status]}</h2>
        <div className="my-3 flex flex-wrap gap-2">{task.status === 'running' ? <button className="work-command" onClick={() => store.cancelTask(task.id)}>停止此任务</button> : <>
          <button className="work-command" disabled={busy} onClick={() => { if (task.officeInput) { change(task.officeInput); setProfileId(task.profileId); } }}>复用输入（新任务）</button>
          <button className="work-command" onClick={() => { if (window.confirm('删除此任务、执行记录和全部成果？')) void store.removeTask(task.id).catch(e => setError(e instanceof Error ? e.message : '删除失败。')); }}>删除此任务</button>
        </>}</div>
        {task.error && <p className="text-sm text-danger">{task.error}</p>}{task.summary && <p className="whitespace-pre-wrap break-words text-sm">{task.summary}</p>}
        <p className="mt-3 text-xs text-ink-secondary">已保存 {artifacts.length} 个成果；失败或中断任务中的成果需自行核对。</p>
        <ol className="mt-3 grid gap-2">{task.toolRunIds.map(id => store.toolRuns.find(tool => tool.id === id)).filter(Boolean).map(tool => <li key={tool!.id} className="rounded border border-line p-2 text-sm"><details><summary>{toolText[tool!.tool] || tool!.tool} · {statusText[tool!.status]}</summary>
          {tool!.arguments && <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">{tool!.arguments}</pre>}{tool!.result && <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">{tool!.result}</pre>}{tool!.error && <p>{tool!.error}</p>}</details></li>)}</ol>
        {store.storageError && <button className="work-command mt-3" onClick={() => void store.retryStorage().catch(e => setError(e instanceof Error ? e.message : '保存失败。'))}>重试本机保存</button>}
        {!!artifacts.length && <label className="work-label mt-4">选择成果<select className="work-input" value={artifact?.id || ''} onChange={e => setSelectedArtifact(e.target.value)}>{artifacts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
        {artifact && <ToolArtifact key={artifact.id} artifact={artifact} running={task.status === 'running'} />}
      </section>}
    </div></div>
  </section>;
}
