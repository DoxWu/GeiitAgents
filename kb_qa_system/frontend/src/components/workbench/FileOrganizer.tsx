import { useMemo, useRef, useState } from 'react';
import { Download, FolderOpen, RefreshCw } from 'lucide-react';
import { applyRenamePlan, type OrganizerDirectoryHandle } from '@/fileOrganizer/apply';
import { makeRenamePlan, planMarkdown, type LocalFileEntry, type RenamePlan } from '@/fileOrganizer/plan';

declare global { interface Window { showDirectoryPicker?: () => Promise<OrganizerDirectoryHandle> } }
function download(content: string, name: string, type: string) { const url = URL.createObjectURL(new Blob([content], { type })); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

export function FileOrganizer() {
  const [files, setFiles] = useState<LocalFileEntry[]>([]), [prefix, setPrefix] = useState('归档'), [plan, setPlan] = useState<RenamePlan[]>([]), [error, setError] = useState('');
  const [directory, setDirectory] = useState<OrganizerDirectoryHandle | null>(null), input = useRef<HTMLInputElement>(null);
  const load = async (list: FileList | File[]) => { const entries: LocalFileEntry[] = []; for (const file of Array.from(list)) { if (file.name.startsWith('.')) continue; entries.push({ path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, name: file.name, size: file.size, modifiedAt: file.lastModified, type: file.type }); if (entries.length >= 500) break; } setFiles(entries); setPlan([]); };
  const ready = useMemo(() => plan.filter(item => item.status === 'ready'), [plan]);
  async function pickDirectory() {
    setError('');
    if (!window.showDirectoryPicker) { setError('当前浏览器不支持受限目录操作，请使用“选择目录文件”生成清单。'); return; }
    try { const handle = await window.showDirectoryPicker(); const entries: LocalFileEntry[] = []; for await (const entry of handle.values()) { if (entry.kind !== 'file' || entry.name.startsWith('.')) continue; const file = await entry.getFile(); entries.push({ path: entry.name, name: entry.name, size: file.size, modifiedAt: file.lastModified, type: file.type }); if (entries.length >= 500) break; } setDirectory(handle); setFiles(entries); setPlan([]); } catch (e) { if ((e as DOMException).name !== 'AbortError') setError('无法读取所选目录。'); }
  }
  function build() { if (!files.length) { setError('请先选择文件或目录。'); return; } setError(''); setPlan(makeRenamePlan(files, prefix)); }
  async function apply() {
    if (!directory || !ready.length) return;
    setError('');
    try {
      await applyRenamePlan(directory, plan);
      setFiles(files.map(file => { const item = plan.find(entry => entry.source === file.name); return item?.status === 'ready' ? { ...file, name: item.target, path: item.target } : file; })); setPlan([]);
    } catch (e) { setError(e instanceof Error ? e.message : '应用整理计划失败；未能确认全部结果。'); }
  }
  return <section className="flex min-h-0 flex-1 flex-col" aria-label="文件整理">
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3"><FolderOpen size={17} /><strong>文件整理</strong><span className="text-xs text-ink-secondary">先预览变更，再应用</span></div>
    <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-6"><div className="mx-auto max-w-5xl">
      <p className="text-sm text-ink-secondary">仅处理用户明确选择的平面目录或文件清单，不递归进入子目录，不覆盖已有文件，不上传内容。浏览器兼容模式只生成变更清单；桌面支持目录 API 时才显示应用入口。</p>
      <div className="mt-5 flex flex-wrap gap-2"><button className="work-command" onClick={() => input.current?.click()}>选择目录文件</button><button className="work-command" onClick={() => void pickDirectory()}>选择可整理目录</button><input ref={input} hidden type="file" multiple accept="*/*" onChange={event => { if (event.target.files) void load(event.target.files); event.target.value = ''; }} /></div>
      <div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]"><label className="work-label">文件名前缀<input className="work-input" maxLength={40} value={prefix} onChange={event => setPrefix(event.target.value)} /></label><button className="work-command self-end bg-brand text-white" onClick={build}><RefreshCw size={16} />生成变更清单</button></div>
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      <p className="mt-4 text-sm">已选择 {files.length} 个文件{plan.length ? ` · ${ready.length} 个可整理 · ${plan.filter(item => item.status === 'conflict').length} 个冲突` : ''}</p>
      {plan.length > 0 && <><div className="mt-3 overflow-x-auto"><table className="w-full text-sm"><caption className="sr-only">文件整理变更清单</caption><thead><tr><th className="border border-line p-2 text-left">原文件</th><th className="border border-line p-2 text-left">新文件名</th><th className="border border-line p-2 text-left">状态</th></tr></thead><tbody>{plan.map(item => <tr key={item.source}><td className="border border-line p-2">{item.source}</td><td className="border border-line p-2">{item.target}</td><td className="border border-line p-2">{item.status}</td></tr>)}</tbody></table></div><div className="mt-3 flex flex-wrap gap-2"><button className="work-command" onClick={() => download(planMarkdown(plan), '文件整理变更清单.md', 'text/markdown;charset=utf-8')}><Download size={16} />导出清单</button><button className="work-command bg-brand text-white" disabled={!directory || !ready.length} onClick={() => void apply()}>应用可整理项目</button></div>{!directory && <p className="mt-2 text-xs text-ink-secondary">当前没有可写目录句柄，只能导出清单。</p>}</>}
    </div></div>
  </section>;
}
