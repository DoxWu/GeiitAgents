import { useEffect, useMemo, useRef, useState } from 'react';
import type { OrganizerDirectoryHandle } from '@/fileOrganizer/apply';
import { pickOrganizerDirectory } from '@/fileOrganizer/directory';
import { draftText, textBytes, textFormat, type FileEditVersion, type Newline } from '@/fileOrganizer/textEdit';
import { compareArtifactText } from '@/officeTasks/artifactDiff';
import { useWorkbenchStore } from '@/store/workbenchStore';
import { selectTextHistory } from '@/fileOrganizer/historyView';
import { useFileHistory } from './useFileHistory';
import { FileHistoryControls, FileHistoryDetails } from './FileHistoryControls';

function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const statusLabels: Record<FileEditVersion['status'], string> = { 'not-started': '批次未执行', running: '写入中', succeeded: '已完成或核验一致', 'not-applied': '核验为原文', interrupted: '中断待核验', 'needs-attention': '待核验' };
function formatLabel(text: string) {
  const format = textFormat(text);
  return `${textBytes(text).length} 字节 · ${format.newline.toUpperCase()} · ${format.bom ? '有' : '无'} UTF-8 BOM · ${/[\r\n]$/.test(text) ? '有' : '无'}末尾换行`;
}
export function FileTextEditor() {
  const store = useWorkbenchStore(), draft = store.fileEditDraft;
  const history = useFileHistory(store.fileEditVersions, selectTextHistory);
  const [directory, setDirectory] = useState<OrganizerDirectoryHandle | null>(null);
  const [names, setNames] = useState<string[]>([]), [name, setName] = useState('');
  const [acknowledged, setAcknowledged] = useState(false), [loading, setLoading] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [previewId, setPreviewId] = useState('');
  const mounted = useRef(false), handles = useRef(new Set<OrganizerDirectoryHandle>()), working = useRef(false);
  useEffect(() => { mounted.current = true; const grants = handles.current; return () => { mounted.current = false; for (const grant of grants) grant.release?.(); grants.clear(); }; }, []);
  const busy = loading || store.organizerBusy;
  const encoded = useMemo(() => {
    if (!draft) return { text: '', error: '' };
    try { return { text: draftText(draft), error: '' }; }
    catch (e) { return { text: '', error: e instanceof Error ? e.message : '文本格式无效。' }; }
  }, [draft]);
  const preview = draft && previewId === draft.editId && !encoded.error;
  const diff = useMemo(() => preview && draft ? compareArtifactText(draft.before.text, encoded.text) : null, [preview, draft, encoded.text]);
  async function act(operation: () => Promise<void>) {
    if (working.current) return;
    working.current = true; setLoading(true); setError(''); setNotice('');
    try { await operation(); }
    catch (e) { if (mounted.current && (e as DOMException).name !== 'AbortError') setError(e instanceof Error ? e.message : '文件操作失败，请核验并保留草稿。'); }
    finally { working.current = false; if (mounted.current) setLoading(false); }
  }
  async function pick() {
    const selected = await pickOrganizerDirectory();
    if (!mounted.current) { selected.release?.(); return; }
    handles.current.add(selected);
    try {
      const found: string[] = [];
      for await (const entry of selected.values()) if (entry.kind === 'file' && /\.(md|txt)$/i.test(entry.name) && !entry.name.startsWith('.')) {
        found.push(entry.name); if (found.length > 500) throw new Error('目录超过 500 个可见 MD/TXT 文件，请先拆分目录。');
      }
      if (!mounted.current) return;
      if (directory && handles.current.delete(directory)) directory.release?.();
      setDirectory(selected); setNames(found.sort((a, b) => a.localeCompare(b))); setName(''); setAcknowledged(false); setPreviewId('');
    } catch (e) { if (handles.current.delete(selected)) selected.release?.(); throw e; }
  }
  function update(content: string, newline: Newline) {
    if (!draft) return;
    try { store.stageFileEdit(draft.id, content, newline); setPreviewId(''); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : '无法保存草稿。'); }
  }
  return <section className="min-h-0 flex-1 overflow-auto p-4 sm:p-6" aria-label="文本内容编辑"><div className="mx-auto max-w-5xl space-y-4">
    <h2 className="font-semibold">MD/TXT 内容编辑</h2>
    <p className="text-sm text-ink-secondary">仅在你选择文件后读取内容，支持最多 256 KiB 的 UTF-8 文件。原文、草稿和写入版本加密保存在本机，不发送给模型。写入前先保存版本并复核文件；操作期间请勿用其他程序编辑同一文件。</p>
    <fieldset disabled={busy} className="space-y-3">
      <button className="work-command" onClick={() => void act(pick)}>选择文本编辑目录</button>
      <p className="break-all text-sm">已授权目录：{directory?.name || '尚未选择'}。刷新或重新进入后需要重新授权。</p>
      {directory && !directory.identity && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} />我确认这是草稿或历史记录对应的目录。浏览器无法持久验证目录身份，也不能排除其他程序在检查后写入。</label>}
      <div className="flex flex-wrap items-end gap-2"><label className="work-label min-w-0 flex-1">目录中的文本文件<select className="work-input" value={name} disabled={!directory || !!draft} onChange={e => setName(e.target.value)}><option value="">选择文件</option>{names.map(n => <option key={n} value={n}>{n}</option>)}</select></label>
        <button className="work-command" disabled={!directory || !name || !!draft} onClick={() => directory && void act(() => store.openFileEdit(directory, name, acknowledged))}>读取并编辑</button></div>
    </fieldset>
    {error && <p role="alert" className="break-words text-sm text-danger">{error}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {store.storageError && <div role="alert" className="space-y-2 text-sm text-danger"><p>{store.storageError} 文件可能已经写入；重试仅保存本机记录。</p><button className="work-command" disabled={busy} onClick={() => void act(store.retryStorage)}>重试本机保存</button></div>}
    {draft && <section className="space-y-3 rounded border border-line p-3" aria-label="文本编辑草稿">
      <h3 className="break-all font-medium">{draft.directoryName} / {draft.name}{draft.restoredFrom ? ' · 恢复历史原文' : ''}</h3>
      <p className="text-xs text-ink-secondary">{store.fileEditSaving ? '草稿等待加密保存…' : '草稿已加密保存'}。切换页面后可继续；这里只保留一个文本草稿，读取其他文件前请完成或丢弃。</p>
      <p className="text-xs">原文件：{formatLabel(draft.before.text)}</p>
      <label className="work-label">写入换行格式<select className="work-input" value={draft.newline} disabled={busy || draft.restoreText !== undefined} onChange={e => update(draft.content, e.target.value as Newline)}>
        <option value="lf">LF</option><option value="crlf">CRLF（Windows）</option><option value="cr">CR</option>{draft.newline === 'mixed' && <option value="mixed">混合格式（编辑前请选择）</option>}
      </select></label>
      <label className="work-label">编辑内容<textarea aria-label="文本编辑内容" className="work-input min-h-64 font-mono text-sm" spellCheck={false} value={draft.content} readOnly={busy || draft.restoreText !== undefined} onChange={e => update(e.target.value, draft.newline)} /></label>
      {draft.restoreText !== undefined && <p className="text-xs">将按历史原文的字节恢复，包括 BOM 和混合换行；当前文件会成为新记录中的原文，仍需预览和确认。</p>}
      {encoded.error && <p role="alert" className="text-sm text-danger">{encoded.error}</p>}
      <div className="flex flex-wrap gap-2"><button className="work-command" disabled={busy || !!encoded.error} onClick={() => setPreviewId(draft.editId)}>预览文本差异</button>
        <button className="work-command" disabled={!!encoded.error} onClick={() => download(encoded.text, '草稿-' + draft.name)}>导出草稿（明文）</button>
        <button className="work-command" onClick={() => download(draft.before.text, '原文-' + draft.name)}>导出读取时原文（明文）</button>
        <button className="work-command" disabled={busy} onClick={() => { if (window.confirm('丢弃当前文本草稿？文件和已有版本记录不会改变。')) void act(() => store.discardFileEdit(draft.id)); }}>丢弃文本草稿</button></div>
      {preview && diff && <section aria-label="文本差异预览" className="space-y-3 border-t border-line pt-3">
        <h4 className="font-medium">写入前预览</h4><p className="text-xs">写入版本：{formatLabel(encoded.text)}。BOM、换行或末尾换行变化也会写入。</p>
        {diff.identical ? <p className="text-sm">内容没有变化。</p> : <>
          <p className="text-sm">{diff.mode === 'too-large' ? '文本超过逐行对比范围，请检查下面完整原文和写入版本。' : diff.mode === 'coarse' ? '变更较多，显示整段差异；请同时检查完整文本。' : `新增 ${diff.added} 行，移除 ${diff.removed} 行。`}{diff.rows.length > 400 ? ' 行差异仅显示前 400 行，完整文本见下方。' : ''}</p>
          {!!diff.rows.length && <pre className="max-h-64 overflow-auto rounded bg-surface-secondary p-3 text-xs" aria-label="逐行差异">{diff.rows.slice(0, 400).map((row, i) => <span className={`block ${row.kind === 'add' ? 'text-success' : row.kind === 'remove' ? 'text-danger' : ''}`} key={i}>{row.kind === 'add' ? '+ ' : row.kind === 'remove' ? '- ' : '  '}{row.text.replace(/\r/g, '␍').replace(/\n$/, '')}</span>)}</pre>}
          <div className="grid gap-3 md:grid-cols-2"><label className="work-label">完整原文<textarea readOnly className="work-input h-48 font-mono text-xs" value={draft.before.text} /></label><label className="work-label">完整写入版本<textarea readOnly className="work-input h-48 font-mono text-xs" value={encoded.text} /></label></div>
          <button className="work-command bg-brand text-white" disabled={busy || !directory || (!directory.identity && !acknowledged) || !!store.storageError} onClick={() => directory && void act(async () => { await store.commitFileEdit(directory, previewId, acknowledged); if (mounted.current) { setPreviewId(''); setNotice('文件已写入并校验，前后版本已加密保存。'); } })}>确认写入所选文件</button>
        </>}
      </section>}
    </section>}
    <section className="space-y-3 border-t border-line pt-4" aria-label="文本版本历史"><h3 className="font-semibold">文本版本历史</h3>
      <p className="text-xs text-ink-secondary">最多 50 条、前后文本合计 2 MiB，存储配额可能更早耗尽；不自动淘汰版本。中断后先核验；核验只比较当前内容，不会重放写入。原生写入会尝试失败回滚，但不保证断电时自动恢复。</p>
      {!store.fileEditVersions.length && <p className="text-sm">暂无文本版本</p>}
      <FileHistoryControls {...history} label="文本历史" statuses={statusLabels} busy={busy} />
      {history.rows.map(record => <FileHistoryDetails key={record.id} summary={<>{record.directoryName} / {record.name} · {statusLabels[record.status]} · {new Date(record.createdAt).toLocaleString()}</>}>{() => <>
        <p className="mt-2 break-all text-xs">记录 {record.id}{record.restoredFrom ? ' · 恢复自 ' + record.restoredFrom : ''}{record.batch ? ' · 批次 ' + record.batch.id : ''}</p>
        {record.error && <p className="mt-2 break-words text-sm text-danger">{record.error}</p>}
        {record.inspection && <p className="mt-2 text-sm">最近核验：{record.inspection.outcome === 'after' ? '当前文件与写入版本一致' : record.inspection.outcome === 'before' ? '当前文件与原文一致' : '当前文件不同或已被替换，请保留现场'}（{new Date(record.inspection.checkedAt).toLocaleString()}）</p>}
        <div className="mt-3 flex flex-wrap gap-2"><button className="work-command" disabled={busy || !directory} onClick={() => directory && void act(() => store.inspectFileEdit(directory, record.id, acknowledged))}>核验当前文件</button>
          <button className="work-command" disabled={busy || !directory || !!draft} onClick={() => directory && void act(async () => { await store.openFileEdit(directory, record.name, acknowledged, record.id); if (mounted.current) setPreviewId(useWorkbenchStore.getState().fileEditDraft?.editId || ''); })}>预览恢复此记录原文</button>
          <button className="work-command" onClick={() => download(record.before.text, '历史原文-' + record.name)}>导出历史原文（明文）</button>
          <button className="work-command" onClick={() => download(record.after.text, '历史写入-' + record.name)}>导出历史写入（明文）</button>
          <button className="work-command" disabled={busy || !['succeeded', 'not-applied', 'not-started'].includes(record.status)} onClick={() => { if (window.confirm('删除这条文本历史后将无法通过它恢复。请先导出需要的原文。继续？')) void act(() => store.removeFileEditVersion(record.id)); }}>删除文本记录</button></div>
      </>}</FileHistoryDetails>)}
    </section>
  </div></section>;
}
