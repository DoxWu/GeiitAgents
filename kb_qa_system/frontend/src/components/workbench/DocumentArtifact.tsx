import { useEffect, useRef, useState } from 'react';
import { Download, Pencil, Save } from 'lucide-react';
import { PrivateMarkdown } from './LocalMarkdown';
import { useWorkbenchStore } from '@/store/workbenchStore';
import type { WorkArtifact } from '@/types/workbench';

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function DocumentArtifact({ versions }: { versions: WorkArtifact[] }) {
  const store = useWorkbenchStore();
  const ordered = [...versions].sort((a, b) => b.version - a.version);
  const [selected, setSelected] = useState('');
  const artifact = ordered.find(item => item.id === selected) ?? ordered[0];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (editing && draft !== artifact?.content) event.preventDefault(); };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [editing, draft, artifact?.content]);
  if (!artifact) return null;
  async function save() {
    setBusy(true); setError(''); setNotice('');
    try {
      const id = await store.saveArtifactVersion(artifact.id, draft);
      if (mounted.current) { setSelected(id); setEditing(false); setDraft(''); setNotice('版本已保存到本机加密库。'); }
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : '保存失败。'); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function exportWord() {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await store.exportArtifactDocx(artifact.id);
      if (mounted.current && useWorkbenchStore.getState().unlocked) {
        download(new Blob([result.bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), result.name);
        setNotice(['已生成所选版本的 DOCX。', ...result.warnings].join(' '));
      }
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : '导出失败。'); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <article className="mt-6 border-t border-line pt-5" aria-label="文档成果">
    <div className="flex flex-wrap items-center gap-3"><div className="min-w-0 flex-1"><h3 className="truncate font-semibold">{artifact.name}</h3><p className="mt-1 text-xs text-ink-secondary">版本 {artifact.version} · SHA-256 {artifact.sha256.slice(0, 12)}…</p></div>
      <select aria-label="成果版本" className="work-input w-auto" value={artifact.id} disabled={busy || editing} onChange={e => { setSelected(e.target.value); setError(''); setNotice(''); }}>
        {ordered.map(item => <option key={item.id} value={item.id}>版本 {item.version}{item.parentArtifactId ? ' · 手动编辑' : ' · 模型生成'}</option>)}
      </select>
    </div>
    <div className="mt-3 flex flex-wrap gap-2">
      <button className="work-command" disabled={busy || editing} onClick={() => download(new Blob([artifact.content], { type: 'text/markdown;charset=utf-8' }), `${artifact.name.replace(/\.md$/i, '')}-v${artifact.version}.md`)}><Download size={16} />下载 Markdown</button>
      <button className="work-command" disabled={busy || editing} onClick={() => void exportWord()}><Download size={16} />{busy && !editing ? '正在导出…' : '导出 DOCX'}</button>
      {!editing && <button className="work-command" disabled={busy || artifact.id !== ordered[0].id} onClick={() => { setDraft(artifact.content); setEditing(true); setSelected(artifact.id); setNotice(''); setError(''); }}><Pencil size={16} />编辑新版本</button>}
    </div>
    <p className="mt-3 text-xs leading-5 text-ink-secondary">编辑保存为新版本，旧版本保留。DOCX 在本机转换，支持标题、列表、表格和代码；图片、链接、HTML 以文字保留。下载文件为明文。复杂版式请在 Word 中检查。</p>
    {editing && <div className="mt-4">
      <label className="work-label">编辑 Markdown<textarea aria-label="编辑 Markdown" className="work-input min-h-80 resize-y font-mono" value={draft} disabled={busy} maxLength={1000000} onChange={e => setDraft(e.target.value)} /></label>
      <p className="mt-2 text-xs text-ink-secondary">草稿尚未保存；切换任务、页签或锁定会丢弃草稿。</p>
      <div className="mt-3 flex gap-2"><button className="work-command" disabled={busy || !draft.trim()} onClick={() => void save()}><Save size={16} />{busy ? '保存中…' : '保存新版本'}</button>
        <button className="work-command" disabled={busy} onClick={() => { if (draft === artifact.content || window.confirm('放弃未保存的修改？')) { setEditing(false); setDraft(''); } }}>放弃修改</button></div>
    </div>}
    {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
    {notice && <p role="status" className="mt-3 text-sm text-ink-secondary">{notice}</p>}
    <div className="mt-5"><PrivateMarkdown content={editing ? draft : artifact.content} /></div>
  </article>;
}
