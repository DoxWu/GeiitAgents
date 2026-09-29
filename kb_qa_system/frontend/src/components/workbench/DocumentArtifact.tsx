import { useEffect, useRef, useState } from 'react';
import { Download, FileCode2, GitCompareArrows, Pencil, RotateCcw, Save } from 'lucide-react';
import { PrivateMarkdown } from './LocalMarkdown';
import { useWorkbenchStore } from '@/store/workbenchStore';
import type { WorkArtifact } from '@/types/workbench';
import { ArtifactComparison } from './ArtifactComparison';
import { documentExportContent } from '@/officeTasks/document';
import { finishLabel } from '@/services/modelStream';

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
  const [comparing, setComparing] = useState(false);
  const [restorePlan, setRestorePlan] = useState<{ sourceId: string; latestId: string; sourceVersion: number; nextVersion: number } | null>(null);
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
  async function exportHtml() {
    setBusy(true); setError(''); setNotice('');
    try {
      const { markdownToHtml } = await import('@/officeTasks/html');
      const result = markdownToHtml(documentExportContent(artifact), artifact.name.replace(/\.md$/i, ''));
      if (mounted.current && useWorkbenchStore.getState().unlocked) {
        download(new Blob([result.html], { type: 'text/html;charset=utf-8' }), `${artifact.name.replace(/\.md$/i, '')}-v${artifact.version}.html`);
        setNotice(['已生成所选版本的 HTML。', ...result.warnings].join(' '));
      }
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : '导出失败。'); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function restore() {
    if (!restorePlan) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const id = await store.restoreArtifactVersion(restorePlan.sourceId, restorePlan.latestId);
      if (mounted.current) { setSelected(id); setRestorePlan(null); setNotice(`已将版本 ${restorePlan.sourceVersion} 的内容保存为新版本，原有版本保留。`); }
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : '恢复失败。'); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <article className="mt-6 border-t border-line pt-5" aria-label="文档成果">
    <div className="flex flex-wrap items-center gap-3"><div className="min-w-0 flex-1"><h3 className="truncate font-semibold">{artifact.name}</h3><p className="mt-1 text-xs text-ink-secondary">版本 {artifact.version} · SHA-256 {artifact.sha256.slice(0, 12)}…</p></div>
      <select aria-label="成果版本" className="work-input w-auto" value={artifact.id} disabled={busy || editing} onChange={e => { setSelected(e.target.value); setError(''); setNotice(''); setRestorePlan(null); }}>
        {ordered.map(item => <option key={item.id} value={item.id}>版本 {item.version}{item.restoredFromArtifactId ? ` · 恢复自版本 ${ordered.find(source => source.id === item.restoredFromArtifactId)?.version ?? '未知'}` : item.parentArtifactId ? ' · 手动编辑' : ' · 模型生成'}</option>)}
      </select>
    </div>
    <div className="mt-3 flex flex-wrap gap-2">
      <button className="work-command" disabled={busy || editing} onClick={() => download(new Blob([documentExportContent(artifact)], { type: 'text/markdown;charset=utf-8' }), `${artifact.name.replace(/\.md$/i, '')}-v${artifact.version}.md`)}><Download size={16} />下载 Markdown</button>
      <button className="work-command" disabled={busy || editing} onClick={() => void exportWord()}><Download size={16} />{busy && !editing ? '正在导出…' : '导出 DOCX'}</button>
      <button className="work-command" disabled={busy || editing} onClick={() => void exportHtml()}><FileCode2 size={16} />导出 HTML</button>
      {!editing && <button className="work-command" disabled={busy || artifact.id !== ordered[0].id} onClick={() => { setDraft(artifact.content); setEditing(true); setSelected(artifact.id); setNotice(''); setError(''); setRestorePlan(null); setComparing(false); }}><Pencil size={16} />编辑新版本</button>}
      {ordered.length > 1 && <button className="work-command" disabled={busy || editing} aria-expanded={comparing} onClick={() => setComparing(value => !value)}><GitCompareArrows size={16} />{comparing ? '关闭版本对比' : '对比版本'}</button>}
      {artifact.id !== ordered[0].id && <button className="work-command" disabled={busy || editing || artifact.content === ordered[0].content} onClick={() => {
        setError(''); setNotice(''); setRestorePlan({ sourceId: artifact.id, latestId: ordered[0].id, sourceVersion: artifact.version, nextVersion: ordered[0].version + 1 });
      }}><RotateCcw size={16} />恢复为新版本</button>}
    </div>
    <p className="mt-3 text-xs leading-5 text-ink-secondary">编辑保存为新版本，旧版本保留。DOCX 和 HTML 在本机转换，图片、链接、HTML 以文字保留，不执行外部内容。下载文件为明文；复杂版式请在目标应用中检查。</p>
    {artifact.finishReason && <p className="mt-3 text-sm text-ink-secondary" aria-label="文档生成状态">{finishLabel(artifact.finishReason)}{artifact.finishReason !== 'stop' ? '。导出会附带此生成状态说明。' : ''}</p>}
    {artifact.id !== ordered[0].id && artifact.content === ordered[0].content && <p className="mt-2 text-xs text-ink-secondary">此版本与最新版本内容相同，无需恢复。</p>}
    {comparing && !editing && <ArtifactComparison key={artifact.id} versions={ordered} target={artifact} />}
    {restorePlan && <section aria-label="确认版本恢复" className="mt-4 rounded border border-line p-3">
      <p className="text-sm">将版本 {restorePlan.sourceVersion} 的完整内容恢复为版本 {restorePlan.nextVersion}，现有全部版本继续保留。仅在本机保存，不调用模型。</p>
      <div className="mt-3 flex flex-wrap gap-2"><button className="work-command" disabled={busy} onClick={() => void restore()}>{busy ? '恢复中…' : '确认恢复'}</button>
        <button className="work-command" disabled={busy} onClick={() => setRestorePlan(null)}>取消恢复</button></div>
    </section>}
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
