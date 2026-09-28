import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, FolderOpen, RefreshCw, Undo2 } from 'lucide-react';
import type { OrganizerDirectoryHandle } from '@/fileOrganizer/apply';
import { makeRenamePlan, planMarkdown, type LocalFileEntry, type RenamePlan } from '@/fileOrganizer/plan';
import { undoPlan, type OrganizerRun } from '@/fileOrganizer/history';
import { useWorkbenchStore } from '@/store/workbenchStore';

declare global { interface Window { showDirectoryPicker?: (options?: { mode: 'readwrite' }) => Promise<OrganizerDirectoryHandle> } }
function download(content: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const statuses: Record<OrganizerRun['status'], string> = { running: '执行中', succeeded: '已完成', failed: '未应用或已回滚', interrupted: '中断待核验', 'needs-attention': '需要人工检查', undone: '已撤销' };
const planStatus = { ready: '可整理', unchanged: '无变化', conflict: '名称冲突', invalid: '无效文件名' };
function localEntry(file: File): LocalFileEntry {
  return { path: file.name, name: file.name, size: file.size, modifiedAt: file.lastModified, type: file.type };
}
async function listDirectory(handle: OrganizerDirectoryHandle) {
  const files: LocalFileEntry[] = []; let stages = 0;
  for await (const entry of handle.values()) {
    if (entry.name.startsWith('.geiit-stage-')) stages++;
    if (entry.kind !== 'file' || entry.name.startsWith('.')) continue;
    if (!entry.getFile) throw new Error('目录不支持文件读取。');
    files.push(localEntry(await entry.getFile()));
    if (files.length > 500) throw new Error('目录超过 500 个可见文件，请先拆分目录后整理。');
  }
  return { files, stages };
}
export function FileOrganizer() {
  const store = useWorkbenchStore();
  const [files, setFiles] = useState<LocalFileEntry[]>([]), [prefix, setPrefix] = useState('归档');
  const [plan, setPlan] = useState<RenamePlan[]>([]), [undoOf, setUndoOf] = useState<string>();
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [loading, setLoading] = useState(false);
  const [directory, setDirectory] = useState<OrganizerDirectoryHandle | null>(null);
  const input = useRef<HTMLInputElement>(null), mounted = useRef(false), selection = useRef(0);
  useEffect(() => { mounted.current = true; const token = selection; return () => { mounted.current = false; token.current++; }; }, []);
  const busy = loading || store.organizerBusy;
  const ready = useMemo(() => plan.filter(item => item.status === 'ready'), [plan]);
  function resetPlan() { setPlan([]); setUndoOf(undefined); setError(''); setNotice(''); }
  function load(list: FileList) {
    selection.current++; setDirectory(null); setFiles([]); resetPlan();
    const visible = Array.from(list).filter(file => !file.name.startsWith('.'));
    if (visible.length > 500) { setError('最多选择 500 个文件。'); return; }
    setFiles(visible.map(localEntry));
  }
  async function pickDirectory() {
    resetPlan(); setDirectory(null); setFiles([]);
    if (!window.showDirectoryPicker) { setError('当前环境不支持目录写入，可通过“选择文件生成清单”预览并导出。'); return; }
    const epoch = ++selection.current; setLoading(true);
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      const result = await listDirectory(handle);
      if (mounted.current && selection.current === epoch) {
        setDirectory(handle); setFiles(result.files);
        if (result.stages) setNotice('此目录有 ' + result.stages + ' 个整理暂存文件。请先核对历史执行记录，勿直接删除副本。');
      }
    } catch (e) { if (mounted.current && selection.current === epoch && (e as DOMException).name !== 'AbortError') setError(e instanceof Error ? e.message : '无法读取目录。'); }
    finally { if (mounted.current && selection.current === epoch) setLoading(false); }
  }
  async function reload() {
    if (!directory) return;
    const epoch = ++selection.current; setLoading(true); resetPlan();
    try { const result = await listDirectory(directory); if (mounted.current && epoch === selection.current) { setFiles(result.files); setNotice(result.stages ? '目录中仍有 ' + result.stages + ' 个暂存副本，请核对历史。' : '目录已重新读取。'); } }
    catch (e) { if (mounted.current) { setDirectory(null); setFiles([]); setError(e instanceof Error ? e.message : '目录读取失败。'); } }
    finally { if (mounted.current) setLoading(false); }
  }
  function build() {
    resetPlan();
    if (!files.length) { setError('请先选择文件或目录。'); return; }
    setPlan(makeRenamePlan(files, prefix));
  }
  async function apply() {
    if (!directory || !ready.length || busy) return;
    const epoch = selection.current;
    setLoading(true); setError(''); setNotice('');
    try {
      const id = await store.runFileOrganizer(directory, plan, undoOf);
      if (mounted.current && epoch === selection.current) {
        const run = useWorkbenchStore.getState().organizerRuns.find(item => item.id === id);
        setPlan([]); setUndoOf(undefined);
        setNotice((run?.kind === 'undo' ? '撤销已完成。' : '整理已完成。') + (run?.warnings?.join(' ') || '记录已保存到本机加密库。'));
        const result = await listDirectory(directory);
        if (mounted.current && epoch === selection.current) setFiles(result.files);
      }
    } catch (e) {
      if (mounted.current) { setError(e instanceof Error ? e.message : '操作失败，请核对目录和执行记录。'); setPlan([]); setUndoOf(undefined); }
    } finally { if (mounted.current && epoch === selection.current) setLoading(false); }
  }
  async function inspect(run: OrganizerRun) {
    if (!directory) return;
    setError(''); setNotice('');
    try { await store.inspectOrganizerRun(directory, run.id); if (mounted.current) setNotice('目录核验完成，请查看该记录状态。本次未修改目录。'); }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : '核验失败。'); }
  }
  return <section className="flex min-h-0 flex-1 flex-col" aria-label="文件整理">
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3"><FolderOpen size={17} /><strong>文件整理</strong><span className="text-xs text-ink-secondary">预览变更、应用、核验与撤销</span></div>
    <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-6"><div className="mx-auto max-w-5xl">
      <p className="text-sm text-ink-secondary">仅处理明确选择的平面目录，不进入子目录、不上传文件内容。每批最多 500 个文件、256 MiB，单文件最多 64 MiB。采用复制校验后删除源文件，文件修改时间可能变化。操作期间请勿用其他程序编辑目录；发生故障时保留恢复副本。当前环境不支持目录写入时可导出清单。</p>
      <fieldset disabled={busy} className="mt-5">
        <div className="flex flex-wrap gap-2"><button className="work-command" onClick={() => input.current?.click()}>选择文件生成清单</button><button className="work-command" onClick={() => void pickDirectory()}>选择可整理目录</button><button className="work-command" disabled={!directory} onClick={() => void reload()}>重新读取目录</button>
          <input ref={input} hidden type="file" multiple aria-label="选择待整理文件" onChange={event => { if (event.target.files) load(event.target.files); event.target.value = ''; }} /></div>
        <p className="mt-3 break-all text-sm">{directory ? '当前可写目录：' + (directory.name || '所选目录') : '当前为只读清单，无可写目录。'}</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]"><label className="work-label">文件名前缀<input className="work-input" maxLength={40} value={prefix} onChange={event => { setPrefix(event.target.value); resetPlan(); }} /></label><button className="work-command self-end bg-brand text-white" onClick={build}><RefreshCw size={16} />生成变更清单</button></div>
      </fieldset>
      {store.organizerBusy && <button className="work-command mt-3" onClick={store.cancelFileOrganizer}>停止整理并恢复</button>}
      {error && <p role="alert" className="mt-3 break-words text-sm text-danger">{error}</p>}
      {notice && <p role="status" className="mt-3 break-words text-sm">{notice}</p>}
      {store.storageError && <div className="mt-3 text-sm text-danger"><p>{store.storageError}文件可能已经变更，请勿重复执行。</p><button className="work-command" disabled={busy} onClick={() => void store.retryStorage().catch(e => setError(e instanceof Error ? e.message : '保存失败。'))}>重试本机保存</button></div>}
      <p className="mt-4 text-sm">已选择 {files.length} 个文件{plan.length ? ' · ' + ready.length + ' 个可整理' : ''}</p>
      {plan.length > 0 && <section aria-label="整理计划" className="mt-4">
        {undoOf && <p className="text-sm">正在预览撤销：确认所选目录为原目录。仅恢复文件名，内容必须与记录的摘要一致，原文件名不能被占用。</p>}
        <div className="mt-3 overflow-x-auto"><table className="w-full text-sm"><caption className="sr-only">文件整理变更清单</caption><thead><tr><th className="border border-line p-2 text-left">当前文件</th><th className="border border-line p-2 text-left">目标文件名</th><th className="border border-line p-2 text-left">状态</th></tr></thead><tbody>{plan.map((item, index) => <tr key={index}><td className="break-all border border-line p-2">{item.source}</td><td className="break-all border border-line p-2">{item.target}</td><td className="border border-line p-2">{planStatus[item.status]}</td></tr>)}</tbody></table></div>
        <div className="mt-3 flex flex-wrap gap-2"><button className="work-command" onClick={() => download(planMarkdown(plan), '文件整理变更清单.md', 'text/markdown;charset=utf-8')}><Download size={16} />导出清单</button><button className="work-command bg-brand text-white" disabled={busy || !directory || !ready.length || !store.unlocked} onClick={() => void apply()}>{undoOf ? '确认撤销所选目录中的变更' : '应用可整理项目'}</button></div>
      </section>}
      <section className="mt-6 border-t border-line pt-4" aria-label="整理历史">
        <h2 className="font-semibold">本机整理历史</h2><p className="mt-2 text-xs text-ink-secondary">记录加密保存文件名、摘要和暂存位置，不保存文件内容或目录权限。重开后请重新选择原目录；中断记录先核验，不自动重放。导出记录为明文。</p>
        {!store.organizerRuns.length && <p className="mt-3 text-sm">暂无整理记录</p>}
        {store.organizerRuns.map(run => <details className="mt-3 rounded border border-line p-3" key={run.id}>
          <summary className="cursor-pointer break-all text-sm">{run.kind === 'undo' ? '撤销' : '整理'} · {run.directoryName} · {statuses[run.status]} · {new Date(run.createdAt).toLocaleString()}</summary>
          <p className="mt-2 text-xs">记录 {run.id}</p>{run.error && <p className="mt-2 text-sm text-danger">{run.error}</p>}{run.warnings?.map(warning => <p className="mt-2 text-sm" key={warning}>{warning}</p>)}
          {!!run.retainedFiles?.length && <p className="mt-2 break-all text-sm">保留副本：{run.retainedFiles.join('、')}</p>}
          <ul className="mt-2 text-xs">{run.changes.map(item => <li className="mt-2 break-all" key={item.source}>{item.source} → {item.target}<br />SHA-256：{item.sha256}<br />暂存位置（成功后通常已清理）：{item.stage}</li>)}</ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <button className="work-command" disabled={busy || !directory || run.kind !== 'rename' || run.status !== 'succeeded'} onClick={() => { resetPlan(); setPlan(undoPlan(run)); setUndoOf(run.id); }}><Undo2 size={15} />预览撤销</button>
            <button className="work-command" disabled={busy || !directory || run.status === 'undone'} onClick={() => void inspect(run)}>核验目录</button>
            <button className="work-command" onClick={() => download(JSON.stringify(run, null, 2), '整理记录-' + run.id + '.json', 'application/json;charset=utf-8')}>导出记录</button>
            <button className="work-command" disabled={busy || ['running', 'interrupted', 'needs-attention'].includes(run.status) || !!run.retainedFiles?.length} onClick={() => { if (window.confirm('删除此历史记录后无法通过它撤销。继续？')) void store.removeOrganizerRun(run.id).catch(e => setError(e instanceof Error ? e.message : '删除失败。')); }}>删除记录</button>
          </div>
        </details>)}
      </section>
    </div></div>
  </section>;
}
