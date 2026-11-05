import { Hint } from './Hint';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { CheckCircle2, ClipboardList, FileUp, Loader2, Play, Plus, RotateCcw, Square, Trash2, XCircle } from 'lucide-react';
import { DocumentArtifact } from './DocumentArtifact';
import { ACCOUNT_MODEL_ID, useWorkbenchStore } from '@/store/workbenchStore';
import { readLocalDocument } from '@/localKnowledge/documentImport';
import { readWorkImages } from '@/services/workbenchImages';
import type { WorkImage } from '@/types/workbench';
import type { TaskRun } from '@/types/workbench';
import type { DocumentOutputFormat } from '@/officeTasks/document';
import { finishLabel } from '@/services/modelStream';
import { GenerationPreview } from './GenerationPreview';
import { ReferenceLibrary } from './ReferenceLibrary';
import { useWorkbenchFence } from '@/hooks/useWorkbenchFence';
import { MAX_CONVERSATION_IMAGE_BYTES, MAX_IMAGES_PER_TASK } from '@/services/workbenchImages';

const statusText: Record<TaskRun['status'], string> = { running: '运行中', succeeded: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };

const PptxDesigner = lazy(() => import('./PptxDesigner').then(m => ({ default: m.PptxDesigner })));
export function DocumentTasks() {
  const store = useWorkbenchStore();
  const capture = useWorkbenchFence(), fileRequest = useRef(0), navigationVersion = useRef(0);
  const [selectedId, setSelectedId] = useState(() => store.taskRuns.find(item => item.type === 'document.generate-markdown')?.id ?? '');
  const [outputFormat, onFormat] = useState<DocumentOutputFormat>('docx');
  const [pptVisited, setPptVisited] = useState(false), [pptSource, setPptSource] = useState<TaskRun>(), [pptSession, setPptSession] = useState(0);
  const [profileId, setProfileId] = useState('');
  const [title, setTitle] = useState('');
  const [instruction, setInstruction] = useState('');
  const [referenceImages, setReferenceImages] = useState<WorkImage[]>([]), [warnings, setWarnings] = useState<string[]>([]);
  const latestImages = useRef(referenceImages); latestImages.current = referenceImages;
  const [sourceName, setSourceName] = useState('');
  const [sourceContent, setSourceContent] = useState('');
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const documentTasks = store.taskRuns.filter(item => item.type === 'document.generate-markdown');
  const task = documentTasks.find(item => item.id === selectedId);
  const creating = !task;
  const pptTask = task && ['pptx-design.json', 'pptx-layout.json'].includes(task.sourceName ?? '');
  const artifacts = task ? store.artifacts.filter(item => item.kind === 'markdown' && task.artifactIds.includes(item.id)) : [];
  const tools = task ? store.toolRuns.filter(item => item.taskId === task.id) : [];
  const profile = store.profiles.find(item => item.id === profileId);
  const cloud = profileId === ACCOUNT_MODEL_ID || ['relay', 'direct'].includes(profile?.mode || '');
  const connectionSignature = JSON.stringify([profile, store.accountModel]);
  useEffect(() => { if (!profileId) setProfileId(store.profiles[0]?.id ?? (store.accountModel ? ACCOUNT_MODEL_ID : '')); }, [profileId, store.profiles, store.accountModel]);
  useEffect(() => { setConsent(false); }, [profileId, sourceContent, sourceName, instruction, title, outputFormat, referenceImages, connectionSignature]);
  useEffect(() => {
    if (!store.unlocked) { fileRequest.current++; setTitle(''); setInstruction(''); setSourceName(''); setSourceContent(''); setReferenceImages([]); setWarnings([]); setConsent(false); setError(''); }
  }, [store.unlocked]);
  async function open(file?: File) {
    if (!file) return;
    const current = capture(), request = ++fileRequest.current; setError('');
    try {
      let doc: { text: string; importWarnings?: string[] };
      if (/\.xlsx$/i.test(file.name)) {
        if (file.size > 2000000) throw new Error('XLSX 参考文件不能超过2 MB。');
        const { parseFirstXlsxSheet } = await import('@/officeTasks/xlsx');
        const sheet = await parseFirstXlsxSheet(await file.arrayBuffer());
        doc = { text: sheet.csv, importWarnings: [`已提取工作表“${sheet.sheetName}”的可读数据；未复制公式、样式或其他工作表。`] };
      } else if (/\.csv$/i.test(file.name)) {
        if (file.size > 400000) throw new Error('CSV 参考文件过大。');
        doc = { text: await file.text() };
      } else doc = await readLocalDocument(file);
      if (doc.text.length > 100000) throw new Error('参考材料最多100000字符。');
      if (!current() || request !== fileRequest.current) return;
      setSourceName(file.name); setSourceContent(doc.text); setWarnings(doc.importWarnings ?? []);
    } catch (e) { if (current() && request === fileRequest.current) setError(e instanceof Error ? e.message : '参考文件解析失败。'); }
  }

  async function start(event: React.FormEvent) {
    event.preventDefault(); const current = capture(); setError(''); setSubmitting(true);
    const navigation = navigationVersion.current;
    const previous = new Set(store.taskRuns.map(item => item.id));
    const pending = store.startDocumentTask(profileId, { title, instruction, outputFormat, referenceImages, ...(sourceContent ? { sourceName: sourceName || '粘贴材料.txt', sourceContent } : {}) }, consent);
    setConsent(false);
    queueMicrotask(() => {
      const created = useWorkbenchStore.getState().taskRuns.find(item => !previous.has(item.id));
      if (created?.type === 'document.generate-markdown' && current() && navigation === navigationVersion.current) setSelectedId(created.id);
    });
    try { const id = await pending; if (current() && navigation === navigationVersion.current) setSelectedId(id); }
    catch (e) { if (current() && navigation === navigationVersion.current) setError(e instanceof Error ? e.message : '文档任务失败。'); }
    finally { setSubmitting(false); }
  }
  function reuse(item: TaskRun) {
    fileRequest.current++; navigationVersion.current++;
    if (item.outputFormat === 'pptx' || ['pptx-design.json', 'pptx-layout.json'].includes(item.sourceName ?? '')) {
      setPptSource(item); setPptSession(value => value + 1); setPptVisited(true); onFormat('pptx'); setSelectedId(''); setConsent(false); setError(''); return;
    }
    setTitle(item.title); setInstruction(item.instruction); setSourceName(item.sourceName ?? ''); setSourceContent(item.sourceContent ?? '');
    onFormat(item.outputFormat ?? 'markdown'); setReferenceImages(item.referenceImages ?? []);
    setProfileId(item.profileId); setConsent(false); setWarnings([]); setError(''); setSelectedId('');
  }
  function newTask() {
    fileRequest.current++; navigationVersion.current++; setSelectedId(''); setTitle(''); setInstruction(''); setSourceName(''); setSourceContent('');
    setReferenceImages([]); setWarnings([]); setConsent(false); setError(''); setPptSource(undefined); setPptSession(value => value + 1);
  }
  return <section className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[260px_minmax(0,1fr)]" aria-label="文档任务">
    <aside className="flex max-h-52 min-h-0 flex-col border-b border-line md:max-h-none md:border-b-0 md:border-r" aria-label="文档任务列表">
      <div className="shrink-0 border-b border-line p-3"><button className={`work-command w-full justify-center ${creating ? 'bg-brand text-white' : ''}`} aria-current={creating ? 'page' : undefined} onClick={newTask}><Plus size={16} />新建文档任务</button></div>
      <div className="min-h-0 flex-1 overflow-auto p-3"><div className="mb-2 flex items-center gap-2 px-2"><ClipboardList size={17} /><h2 className="text-sm font-semibold">历史任务</h2></div>
      {!documentTasks.length && <p className="px-2 py-6 text-sm text-ink-tertiary">尚无任务记录</p>}
      {documentTasks.map(item => <button key={item.id} aria-current={task?.id === item.id ? 'page' : undefined} className={`mb-1 block w-full rounded p-2 text-left ${task?.id === item.id ? 'bg-muted' : 'hover:bg-muted'}`} onClick={() => { fileRequest.current++; navigationVersion.current++; setSelectedId(item.id); setConsent(false); setError(''); }}>
        <span className="block truncate text-sm font-medium">{item.title}</span><span className="mt-1 flex items-center gap-1 text-xs text-ink-secondary">
          {item.status === 'running' ? <Loader2 size={12} className="animate-spin" /> : item.status === 'succeeded' ? <CheckCircle2 size={12} /> : <XCircle size={12} />}{statusText[item.status]} · {['pptx-design.json', 'pptx-layout.json'].includes(item.sourceName ?? '') ? 'PPTX' : (item.outputFormat ?? 'markdown').toUpperCase()}</span>
      </button>)}</div>
    </aside>
    <div className="min-h-0 min-w-0 overflow-auto p-4 sm:p-6">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-center gap-1"><h1 className="text-xl font-semibold">{creating ? '新建文档任务' : '文档任务详情'}</h1><Hint label="文档生成">从左侧新建任务，选择格式、模板与参考材料。历史任务展示执行记录和成果；复用输入会进入新建界面。任务保存在本机加密库，导出文件为明文，请先审阅。</Hint></div>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div>
        {task && <section className="py-6" aria-label="任务详情">
          <div className="flex flex-wrap items-start gap-3"><div className="min-w-0 flex-1"><h2 className="truncate text-lg font-semibold">{task.title}</h2><p className="mt-1 text-xs text-ink-secondary">{statusText[task.status]} · {new Date(task.updatedAt).toLocaleString()}</p></div>
            {task.status === 'running' ? <button className="work-command" onClick={() => store.cancelTask(task.id)}><Square size={15} />停止</button> : <button className="work-command" onClick={() => reuse(task)}><RotateCcw size={15} />{pptTask ? '继续编辑与导出 PPTX' : '复用输入新建'}</button>}
            <button className="work-icon" title="删除任务" aria-label="删除任务" disabled={task.status === 'running'} onClick={() => { if (window.confirm('删除此任务、工具记录和成果？')) void store.removeTask(task.id).catch(e => setError(e instanceof Error ? e.message : '删除失败。')); }}><Trash2 size={16} /></button></div>
          {task.error && <p className="mt-3 text-sm text-danger">{task.error}</p>}
          {task.status === 'running' && store.generationPreviews[task.id] && <GenerationPreview value={store.generationPreviews[task.id]} label="文档生成中的预览" />}
          <details open={task.status === 'running'} className="mt-4 text-sm"><summary className="cursor-pointer">执行记录 · {tools.length}</summary>{tools.map(tool => <div className="mt-2 break-words text-xs text-ink-secondary" key={tool.id}>
            <p>{tool.tool} · {statusText[tool.status]}{tool.model ? ` · ${tool.model}` : ''}{tool.sourceArtifactId ? ` · 源版本 ${artifacts.find(item => item.id === tool.sourceArtifactId)?.version ?? '未知'}` : ''}</p>
            {tool.finishReason && <p>{finishLabel(tool.finishReason)}</p>}
            {tool.outputArtifactId && <p>{tool.previousArtifactId ? `基于版本 ${artifacts.find(item => item.id === tool.previousArtifactId)?.version ?? '未知'} · ` : ''}生成版本 {artifacts.find(item => item.id === tool.outputArtifactId)?.version ?? '未知'}</p>}
            {tool.outputName && <p>{tool.outputName} · SHA-256 {tool.outputSha256?.slice(0, 12)}…</p>}{tool.error && <p>{tool.error}</p>}{tool.warnings?.map(warning => <p key={warning}>{warning}</p>)}</div>)}</details>
          {store.storageError && <button className="work-command mt-3" onClick={() => void store.retryStorage().catch(e => setError(e instanceof Error ? e.message : '保存失败。'))}>重试本机保存</button>}
          {pptTask ? <p className="mt-4 text-sm text-ink-secondary">此任务保存了逐页设计和生成内容，可继续编辑并导出 PPTX。</p> : !!artifacts.length && <DocumentArtifact key={task.id} versions={artifacts} preferredFormat={task.outputFormat} />}
        </section>}
      </div>
      <div hidden={!creating}>
        <label className="work-label mt-5 max-w-md">输出文件类型<select aria-label="输出文件类型" className="work-input" value={outputFormat} onChange={e => { onFormat(e.target.value as DocumentOutputFormat); if (e.target.value === 'pptx') setPptVisited(true); }}><option value="docx">Word 文档 (.docx)</option><option value="pptx">PowerPoint 演示文稿 (.pptx)</option><option value="xlsx">Excel 工作簿 (.xlsx)</option><option value="xls">Excel 兼容工作簿 (.xls)</option><option value="markdown">Markdown</option><option value="html">网页文件 (.html)</option></select></label>
        <div hidden={outputFormat !== 'pptx'} className="mt-5 min-w-0">{pptVisited && <Suspense fallback={<p className="p-4">加载PPT设计器…</p>}><PptxDesigner embedded sourceTask={pptSource} newSession={pptSession} /></Suspense>}</div>
        <div hidden={outputFormat === 'pptx'}>
        <form className="mt-5 grid gap-4 border-b border-line pb-6" onSubmit={start}>
          <fieldset disabled={submitting} className="grid gap-4 sm:grid-cols-2">
            <label className="work-label">文档标题<input className="work-input" required maxLength={100} value={title} onChange={e => setTitle(e.target.value)} /></label>
            <label className="work-label">生成模板<select className="work-input" aria-label="生成模板" defaultValue="" key={outputFormat} onChange={e => { if (e.target.value) setInstruction(e.target.value); }}><option value="">空白 / 自定义要求</option>{(outputFormat === 'xlsx' || outputFormat === 'xls' ? [['数据台账','生成字段清晰的数据台账，包含日期、项目、负责人、数量、金额、状态；只使用参考材料数据，缺失留空。'],['预算明细','根据参考数据制作预算明细表，列出分类、项目、数量、单价、小计。']] : [['项目报告','生成项目报告，包含摘要、背景、进展、风险、下一步和待确认事项。'],['会议纪要','生成会议纪要，包含会议主题、讨论要点、决策、行动项、责任人和日期。'],['操作指南','按章节组织操作指南，包含目标、前提、步骤、示例、常见问题。']]).map(([name,value]) => <option value={value} key={name}>{name}</option>)}</select></label>
            <label className="work-label">生成模型<select aria-label="文档生成模型" className="work-input" required value={profileId} onChange={e => setProfileId(e.target.value)}><option value="">请选择模型</option>
              {store.profiles.map(item => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}
              {store.accountModel && <option value={ACCOUNT_MODEL_ID}>账号云端模型 · {store.accountModel.model}</option>}</select></label>
            <label className="work-label sm:col-span-2">生成要求<textarea aria-label="生成要求" className="work-input min-h-28 resize-y" required maxLength={10000} value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="例如：整理为项目周报，包含进展、风险、下周计划和待确认事项。" /></label>
            <label className="work-label sm:col-span-2">参考材料（可选）<textarea aria-label="参考材料（可选）" className="work-input min-h-32 resize-y" maxLength={100000} value={sourceContent} onChange={e => { setSourceContent(e.target.value); if (!e.target.value) setSourceName(''); }} placeholder="粘贴文本，或提取 PDF / DOCX / PPTX 参考内容；参考文件不会自动克隆原版式" /></label>
            <div className="sm:col-span-2"><ReferenceLibrary valueName={sourceName || '粘贴材料.txt'} valueContent={sourceContent} disabled={submitting} onLoad={(name, content) => { setSourceName(name); setSourceContent(content); setError(''); }} /></div>
          </fieldset>
          <div className="flex flex-wrap items-center gap-2"><button type="button" className="work-command" disabled={submitting} onClick={() => input.current?.click()}><FileUp size={16} />选择参考文件</button>
            {sourceName && <span className="max-w-72 truncate text-xs text-ink-secondary" title={sourceName}>{sourceName}</span>}
            {sourceContent && <button type="button" className="work-icon" title="移除参考材料" aria-label="移除参考材料" disabled={submitting} onClick={() => { setSourceName(''); setSourceContent(''); }}><XCircle size={16} /></button>}
            <input ref={input} hidden type="file" accept=".md,.markdown,.txt,.pdf,.docx,.pptx,.xlsx,.csv" aria-label="选择任务参考文件" onChange={e => { void open(e.target.files?.[0]); e.target.value = ''; }} /></div>
          <p className="text-xs text-ink-secondary">参考文件提取可读文本，保留解析提示；图片另行插入。XLS为精简兼容工作簿，复杂公式和多表样式请使用XLSX。</p>
          {warnings.map((w,i) => <p className="text-xs text-ink-secondary" key={i}>{w}</p>)}
          <label className="work-label">插入图片<input className="work-input" type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={e => { const current=capture(), files=Array.from(e.target.files??[]); e.target.value=''; void readWorkImages(files).then(images => { if (!current()) return; const next=[...latestImages.current,...images]; if (next.length>MAX_IMAGES_PER_TASK || next.reduce((sum,image)=>sum+image.bytes,0)>MAX_CONVERSATION_IMAGE_BYTES) throw new Error('最多50张图片、合计4 MiB。'); setReferenceImages(next); }).catch(e => { if (current()) setError(e instanceof Error?e.message:'图片无效'); }); }} /></label>
          {referenceImages.map((image,index) => <div className="flex items-center gap-2" key={index}><img src={image.dataUrl} alt={image.name} className="h-12 w-16 object-contain" /><span className="text-xs">{image.name}</span><button type="button" className="work-command" onClick={() => setReferenceImages(images => images.filter((_,i) => i !== index))}>移除图片</button></div>)}
          <p className="break-all text-xs text-ink-secondary">目标：{profile?.baseUrl ?? (profileId === ACCOUNT_MODEL_ID ? '账号配置的服务端模型供应商' : '尚未选择')}</p>
          {cloud && <label className="flex items-start gap-2 text-sm leading-6"><input className="mt-1" type="checkbox" disabled={submitting} checked={consent} onChange={e => setConsent(e.target.checked)} />我允许本次将文档标题、生成要求、参考文本及前3张图片，经应用服务端发送给所选云端模型</label>}
          {profile?.mode === 'local' && <p className="text-xs text-ink-secondary">请求发往上述本机接口；接口背后的模型是否完全离线取决于你的服务配置。</p>}
          <div className="flex flex-wrap gap-2"><button className="work-command bg-brand text-white" disabled={submitting || !profileId || !title.trim() || !instruction.trim() || !!cloud && !consent}><Play size={16} />{submitting ? '任务运行中…' : '开始生成'}</button>
            {store.accountModel === null && <button type="button" className="work-command" disabled={store.accountLoading} onClick={() => void store.refreshAccountModel()}>检查账号模型权限</button>}</div>
        </form>
        </div>
      </div>
      </div>
    </div>
  </section>;
}
