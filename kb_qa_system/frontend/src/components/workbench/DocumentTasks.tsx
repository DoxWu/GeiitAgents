import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, ClipboardList, Download, FileUp, Loader2, Play, RotateCcw, Square, Trash2, XCircle } from 'lucide-react';
import { PrivateMarkdown } from './LocalMarkdown';
import { ACCOUNT_MODEL_ID, useWorkbenchStore } from '@/store/workbenchStore';
import type { TaskRun, WorkArtifact } from '@/types/workbench';

const statusText: Record<TaskRun['status'], string> = { running: '运行中', succeeded: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
function download(artifact: WorkArtifact) {
  const url = URL.createObjectURL(new Blob([artifact.content], { type: `${artifact.mimeType};charset=utf-8` }));
  const link = document.createElement('a'); link.href = url; link.download = artifact.name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function DocumentTasks() {
  const store = useWorkbenchStore();
  const [selectedId, setSelectedId] = useState('');
  const [profileId, setProfileId] = useState('');
  const [title, setTitle] = useState('');
  const [instruction, setInstruction] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [sourceContent, setSourceContent] = useState('');
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const task = store.taskRuns.find(item => item.id === selectedId) ?? store.taskRuns[0];
  const artifact = task ? store.artifacts.find(item => task.artifactIds.includes(item.id)) : undefined;
  const tools = task ? store.toolRuns.filter(item => item.taskId === task.id) : [];
  const profile = store.profiles.find(item => item.id === profileId);
  const cloud = profileId === ACCOUNT_MODEL_ID || profile?.mode === 'relay';
  const connectionSignature = JSON.stringify([profile, store.accountModel]);
  useEffect(() => { if (!profileId) setProfileId(store.profiles[0]?.id ?? (store.accountModel ? ACCOUNT_MODEL_ID : '')); }, [profileId, store.profiles, store.accountModel]);
  useEffect(() => { setConsent(false); }, [profileId, sourceContent, sourceName, instruction, title, connectionSignature]);
  async function open(file?: File) {
    if (!file) return;
    setError('');
    if (!/\.(md|markdown|txt)$/i.test(file.name) || file.size > 2 * 1024 * 1024 || !file.size) { setError('请选择不超过 2 MiB 的非空 Markdown/TXT 文件。'); return; }
    try {
      const content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (!content.trim() || content.includes('\0') || content.length > 100000) throw new Error();
      setSourceName(file.name); setSourceContent(content);
    } catch { setError('参考文件需为 UTF-8 文本，且最多 100000 个字符。'); }
  }
  async function start(event: React.FormEvent) {
    event.preventDefault(); setError(''); setSubmitting(true);
    const previous = new Set(store.taskRuns.map(item => item.id));
    const pending = store.startDocumentTask(profileId, { title, instruction, ...(sourceContent ? { sourceName: sourceName || '粘贴材料.txt', sourceContent } : {}) }, consent);
    setConsent(false);
    queueMicrotask(() => {
      const created = useWorkbenchStore.getState().taskRuns.find(item => !previous.has(item.id));
      if (created) setSelectedId(created.id);
    });
    try { const id = await pending; setSelectedId(id); }
    catch (e) { setError(e instanceof Error ? e.message : '文档任务失败。'); }
    finally { setSubmitting(false); }
  }
  function reuse(item: TaskRun) {
    setTitle(item.title); setInstruction(item.instruction); setSourceName(item.sourceName ?? ''); setSourceContent(item.sourceContent ?? '');
    setProfileId(item.profileId); setConsent(false); setError('');
  }
  return <section className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[260px_minmax(0,1fr)]" aria-label="文档任务">
    <aside className="max-h-56 overflow-auto border-b border-line p-3 md:max-h-none md:border-b-0 md:border-r">
      <div className="mb-2 flex items-center gap-2 px-2"><ClipboardList size={17} /><h2 className="text-sm font-semibold">文档任务</h2></div>
      {!store.taskRuns.length && <p className="px-2 py-6 text-sm text-ink-tertiary">尚无任务记录</p>}
      {store.taskRuns.map(item => <button key={item.id} className={`mb-1 block w-full rounded p-2 text-left ${task?.id === item.id ? 'bg-muted' : 'hover:bg-muted'}`} onClick={() => setSelectedId(item.id)}>
        <span className="block truncate text-sm font-medium">{item.title}</span><span className="mt-1 flex items-center gap-1 text-xs text-ink-secondary">
          {item.status === 'running' ? <Loader2 size={12} className="animate-spin" /> : item.status === 'succeeded' ? <CheckCircle2 size={12} /> : <XCircle size={12} />}{statusText[item.status]}</span>
      </button>)}
    </aside>
    <div className="min-h-0 overflow-auto p-4 sm:p-6">
      <div className="mx-auto max-w-4xl">
        <h1 className="text-xl font-semibold">生成 Markdown 文档</h1>
        <p className="mt-2 text-sm text-ink-secondary">任务和成果保存到本机加密库。模型只收到本次标题、要求和参考文本。关闭或锁定客户端会中断任务；下载文件为明文，内容请先审阅。</p>
        <form className="mt-5 grid gap-4 border-b border-line pb-6" onSubmit={start}>
          <fieldset disabled={submitting} className="grid gap-4 sm:grid-cols-2">
            <label className="work-label">文档标题<input className="work-input" required maxLength={100} value={title} onChange={e => setTitle(e.target.value)} /></label>
            <label className="work-label">生成模型<select aria-label="文档生成模型" className="work-input" required value={profileId} onChange={e => setProfileId(e.target.value)}><option value="">请选择模型</option>
              {store.profiles.map(item => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}
              {store.accountModel && <option value={ACCOUNT_MODEL_ID}>账号云端模型 · {store.accountModel.model}</option>}</select></label>
            <label className="work-label sm:col-span-2">生成要求<textarea className="work-input min-h-28 resize-y" required maxLength={10000} value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="例如：整理为项目周报，包含进展、风险、下周计划和待确认事项。" /></label>
            <label className="work-label sm:col-span-2">参考材料（可选）<textarea className="work-input min-h-32 resize-y" maxLength={100000} value={sourceContent} onChange={e => { setSourceContent(e.target.value); if (!e.target.value) setSourceName(''); }} placeholder="粘贴文本，或选择 Markdown/TXT 文件" /></label>
          </fieldset>
          <div className="flex flex-wrap items-center gap-2"><button type="button" className="work-command" disabled={submitting} onClick={() => input.current?.click()}><FileUp size={16} />选择参考文件</button>
            {sourceName && <span className="max-w-72 truncate text-xs text-ink-secondary" title={sourceName}>{sourceName}</span>}
            {sourceContent && <button type="button" className="work-icon" title="移除参考材料" aria-label="移除参考材料" disabled={submitting} onClick={() => { setSourceName(''); setSourceContent(''); }}><XCircle size={16} /></button>}
            <input ref={input} hidden type="file" accept=".md,.markdown,.txt" aria-label="选择任务参考文件" onChange={e => { void open(e.target.files?.[0]); e.target.value = ''; }} /></div>
          <p className="break-all text-xs text-ink-secondary">目标：{profile?.baseUrl ?? (profileId === ACCOUNT_MODEL_ID ? '账号配置的服务端模型供应商' : '尚未选择')}</p>
          {cloud && <label className="flex items-start gap-2 text-sm leading-6"><input className="mt-1" type="checkbox" disabled={submitting} checked={consent} onChange={e => setConsent(e.target.checked)} />我允许本次将文档标题、生成要求和参考文本，经应用服务端发送给所选云端模型</label>}
          {profile?.mode === 'local' && <p className="text-xs text-ink-secondary">请求发往上述本机接口；接口背后的模型是否完全离线取决于你的服务配置。</p>}
          <div className="flex flex-wrap gap-2"><button className="work-command bg-brand text-white" disabled={submitting || !profileId || !title.trim() || !instruction.trim() || !!cloud && !consent}><Play size={16} />{submitting ? '任务运行中…' : '开始生成'}</button>
            {store.accountModel === null && <button type="button" className="work-command" disabled={store.accountLoading} onClick={() => void store.refreshAccountModel()}>检查账号模型权限</button>}</div>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        </form>
        {task && <section className="py-6" aria-label="任务详情">
          <div className="flex flex-wrap items-start gap-3"><div className="min-w-0 flex-1"><h2 className="truncate text-lg font-semibold">{task.title}</h2><p className="mt-1 text-xs text-ink-secondary">{statusText[task.status]} · {new Date(task.updatedAt).toLocaleString()}</p></div>
            {task.status === 'running' ? <button className="work-command" onClick={() => store.cancelTask(task.id)}><Square size={15} />停止</button> : <button className="work-command" onClick={() => reuse(task)}><RotateCcw size={15} />复用输入</button>}
            <button className="work-icon" title="删除任务" aria-label="删除任务" disabled={task.status === 'running'} onClick={() => { if (window.confirm('删除此任务、工具记录和成果？')) void store.removeTask(task.id).catch(e => setError(e instanceof Error ? e.message : '删除失败。')); }}><Trash2 size={16} /></button></div>
          {task.error && <p className="mt-3 text-sm text-danger">{task.error}</p>}
          <details className="mt-4 text-sm"><summary className="cursor-pointer">执行记录 · {tools.length}</summary>{tools.map(tool => <p className="mt-2 text-xs text-ink-secondary" key={tool.id}>{tool.tool} · {statusText[tool.status]}{tool.model ? ` · ${tool.model}` : ''}</p>)}</details>
          {artifact && <article className="mt-6 border-t border-line pt-5"><div className="flex items-center gap-3"><div className="min-w-0 flex-1"><h3 className="truncate font-semibold">{artifact.name}</h3><p className="mt-1 text-xs text-ink-secondary">版本 {artifact.version} · SHA-256 {artifact.sha256.slice(0, 12)}…</p></div>
            <button className="work-command" onClick={() => download(artifact)}><Download size={16} />下载 Markdown</button></div>
            <div className="mt-5"><PrivateMarkdown content={artifact.content} /></div></article>}
        </section>}
      </div>
    </div>
  </section>;
}
