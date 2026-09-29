import { useEffect, useMemo, useRef, useState } from 'react';
import type { OrganizerDirectoryHandle } from '@/fileOrganizer/apply';
import { pickOrganizerDirectory } from '@/fileOrganizer/directory';
import { type TextBatchRule, type TextBatchRow } from '@/fileOrganizer/textBatch';
import { textBytes, type FileEditVersion } from '@/fileOrganizer/textEdit';
import { compareArtifactText } from '@/officeTasks/artifactDiff';
import { useWorkbenchStore } from '@/store/workbenchStore';

const labels: Record<FileEditVersion['status'], string> = { 'not-started': '未执行', running: '写入中', succeeded: '已完成或核验一致', 'not-applied': '核验为原文', interrupted: '中断待核验', 'needs-attention': '待核验' };
function download(records: FileEditVersion[]) {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ format: 'geiit.text-batch-history', version: 1, records }, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = '文本批次恢复记录.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Difference({ row }: { row: TextBatchRow }) {
  const diff = useMemo(() => row.draft && row.after ? compareArtifactText(row.draft.before.text, row.after.text) : null, [row]);
  if (!row.draft || !row.after || !diff) return null;
  return <section aria-label="批次文件差异" className="space-y-3 rounded border border-line p-3"><h3 className="break-all font-medium">{row.name}</h3>
    <p className="text-xs">原文 {textBytes(row.draft.before.text).length} 字节 → 写入 {textBytes(row.after.text).length} 字节。{diff.mode === 'too-large' ? '超过逐行比较范围，请检查完整文本。' : `新增 ${diff.added} 行，移除 ${diff.removed} 行。`}{diff.rows.length > 400 && '逐行差异只显示前 400 行。'}</p>
    {!!diff.rows.length && <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words bg-surface-secondary p-2 text-xs">{diff.rows.slice(0, 400).map((r, i) => <span key={i} className={`block ${r.kind === 'add' ? 'text-success' : r.kind === 'remove' ? 'text-danger' : ''}`}>{r.kind === 'add' ? '+ ' : r.kind === 'remove' ? '- ' : '  '}{r.text.replace(/\r/g, '␍')}</span>)}</pre>}
    <div className="grid gap-3 md:grid-cols-2"><label className="work-label">批次完整原文<textarea className="work-input h-48 font-mono text-xs" readOnly value={row.draft.before.text} /></label><label className="work-label">批次完整写入版本<textarea className="work-input h-48 font-mono text-xs" readOnly value={row.after.text} /></label></div>
  </section>;
}
export function FileTextBatch() {
  const store = useWorkbenchStore(), preview = store.textBatchPreview;
  const [directory, setDirectory] = useState<OrganizerDirectoryHandle | null>(null), [names, setNames] = useState<string[]>([]), [files, setFiles] = useState<string[]>([]);
  const [rule, setRule] = useState<TextBatchRule>({ find: '', replacement: '', newline: 'keep' });
  const [ack, setAck] = useState(false), [confirmed, setConfirmed] = useState(false), [selected, setSelected] = useState<string[]>([]), [view, setView] = useState('');
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const mounted = useRef(false), working = useRef(false), handles = useRef(new Set<OrganizerDirectoryHandle>());
  useEffect(() => { mounted.current = true; const grants = handles.current; return () => { mounted.current = false; useWorkbenchStore.getState().cancelFileEditBatch(); for (const d of grants) d.release?.(); grants.clear(); }; }, []);
  useEffect(() => { const rows = preview?.rows.filter(r => r.draft && r.after && !r.error) ?? []; setSelected(rows.map(r => r.id)); setView(rows[0]?.id || ''); setConfirmed(false); }, [preview]);
  const busy = loading || store.organizerBusy;
  const batches = useMemo(() => {
    const result = new Map<string, FileEditVersion[]>(); for (const r of store.fileEditVersions) if (r.batch) result.set(r.batch.id, [...(result.get(r.batch.id) ?? []), r]);
    return [...result].map(([id, rows]) => ({ id, rows: rows.sort((a, b) => a.batch!.index - b.batch!.index) }));
  }, [store.fileEditVersions]);
  async function act(operation: () => Promise<void>) {
    if (working.current) return; working.current = true; setLoading(true); setError(''); setNotice('');
    try { await operation(); } catch (e) { if (mounted.current && (e as DOMException).name !== 'AbortError') setError(e instanceof Error ? e.message : '批次操作失败。'); }
    finally { working.current = false; if (mounted.current) setLoading(false); }
  }
  async function pick() {
    store.cancelFileEditBatch(); const d = await pickOrganizerDirectory(); if (!mounted.current) { d.release?.(); return; } handles.current.add(d);
    try {
      const list: string[] = []; for await (const e of d.values()) if (e.kind === 'file' && !e.name.startsWith('.') && /\.(md|txt)$/i.test(e.name)) { list.push(e.name); if (list.length > 500) throw new Error('目录超过 500 个可见文本文件，请先拆分。'); }
      if (!mounted.current) return;
      if (directory && handles.current.delete(directory)) directory.release?.(); setDirectory(d); setNames(list.sort((a, b) => a.localeCompare(b))); setFiles([]); setAck(false);
    } catch (e) { if (handles.current.delete(d)) d.release?.(); throw e; }
  }
  function changeRule(next: TextBatchRule) { store.cancelFileEditBatch(); setRule(next); }
  return <section className="min-h-0 flex-1 overflow-auto p-4 sm:p-6" aria-label="批量文本编辑"><div className="mx-auto max-w-5xl space-y-4">
    <h2 className="font-semibold">批量查找与替换</h2><p className="text-sm text-ink-secondary">在已选目录中逐个选择最多 20 个 UTF-8 MD/TXT 文件，每个最多 256 KiB。按字面内容区分大小写替换，不使用正则、不调用模型；先预览，确认后保存全部前后版本，再逐个写入。中途停止或失败会保留已完成文件，不自动回滚整批。</p>
    <fieldset disabled={busy} className="space-y-3">
      <button className="work-command" onClick={() => void act(pick)}>选择批量编辑目录</button><p className="break-all text-sm">批量目录：{directory?.name || '尚未选择'}</p>
      {directory && !directory.identity && <label className="flex gap-2 text-sm"><input type="checkbox" checked={ack} onChange={e => { setAck(e.target.checked); setConfirmed(false); }} />我确认批量编辑与恢复使用的是正确目录。浏览器无法持久验证目录身份。</label>}
      {names.length > 0 && <div className="max-h-48 overflow-auto rounded border border-line p-3" aria-label="批量文件选择">{names.map(name => <label key={name} className="flex items-start gap-2 break-all text-sm"><input type="checkbox" aria-label={'批量选择文件：' + name} checked={files.includes(name)} disabled={!files.includes(name) && files.length >= 20} onChange={e => { store.cancelFileEditBatch(); setFiles(old => e.target.checked ? [...old, name] : old.filter(n => n !== name)); }} />{name}</label>)}</div>}
      <div className="grid gap-3 md:grid-cols-2"><label className="work-label">批量查找内容<textarea aria-label="批量查找内容" className="work-input h-24" maxLength={10000} value={rule.find} onChange={e => changeRule({ ...rule, find: e.target.value })} /></label><label className="work-label">批量替换内容（可为空）<textarea aria-label="批量替换内容（可为空）" className="work-input h-24" maxLength={10000} value={rule.replacement} onChange={e => changeRule({ ...rule, replacement: e.target.value })} /></label></div>
      <label className="work-label">批量写入换行<select aria-label="批量写入换行" className="work-input" value={rule.newline} onChange={e => changeRule({ ...rule, newline: e.target.value as TextBatchRule['newline'] })}><option value="keep">保留各文件格式（混合换行需另选）</option><option value="lf">LF</option><option value="crlf">CRLF</option><option value="cr">CR</option></select></label>
      <button className="work-command" disabled={!directory || !files.length || !rule.find || !!store.fileEditDraft || !!store.storageError} onClick={() => directory && void act(() => store.prepareFileEditBatch(directory, files, rule, ack))}>读取并预览批次</button>
      {!!store.fileEditDraft && <p className="text-sm">请先在“文本内容编辑”完成或丢弃单文件草稿。</p>}
    </fieldset>
    {busy && <button className="work-command" onClick={() => { store.cancelFileEditBatch(); setNotice('已请求停止，正在等待当前文件操作结束；请核对批次历史。'); }}>停止批次操作</button>}
    {error && <p role="alert" className="break-words text-sm text-danger">{error}</p>}{notice && <p role="status" className="text-sm">{notice}</p>}
    {store.storageError && <div role="alert" className="space-y-2 text-sm text-danger"><p>{store.storageError} 文件可能已经部分写入；重试只保存记录，不继续写盘。</p><button className="work-command" disabled={busy} onClick={() => void act(store.retryStorage)}>重试批次记录保存</button></div>}
    {preview && <section className="space-y-3 rounded border border-line p-3" aria-label="批量文本预览"><h3 className="font-semibold">{preview.mode === 'restore' ? '恢复原文预览' : '批量替换预览'} · 选中 {selected.length} 个变更</h3><p className="text-xs">预览是临时状态，离页或锁库后需要重新读取。全部选中版本会占用既有 50 条/2 MiB 文本历史额度，不自动删除旧历史。</p>
      <fieldset disabled={busy} className="space-y-2">{preview.rows.map(row => <div key={row.id} className="flex flex-wrap items-center gap-2 text-sm"><label className="flex min-w-0 items-start gap-2 break-all"><input type="checkbox" aria-label={'应用批次变更：' + row.name} disabled={!row.draft || !row.after || !!row.error} checked={selected.includes(row.id)} onChange={e => { setSelected(old => e.target.checked ? [...old, row.id] : old.filter(id => id !== row.id)); setConfirmed(false); }} />{row.name} · {row.error || (row.after ? `${row.matches} 处匹配` : '没有变化')}</label>{row.after && <button className="work-command" onClick={() => setView(row.id)}>查看差异：{row.name}</button>}</div>)}</fieldset>
      {preview.rows.find(r => r.id === view) && <Difference row={preview.rows.find(r => r.id === view)!} />}
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" disabled={busy} checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />我已检查所选文件差异，确认写入；失败或停止可能留下部分完成的批次。</label>
      <div className="flex flex-wrap gap-2"><button className="work-command bg-brand text-white" disabled={busy || !confirmed || !selected.length || !directory || (!directory.identity && !ack) || !!store.storageError} onClick={() => directory && void act(async () => { await store.commitFileEditBatch(directory, preview.id, selected, ack); if (mounted.current) setNotice('所选文件已全部写入并校验，版本已加密保存。'); })}>确认写入批次</button><button className="work-command" disabled={busy} onClick={() => store.cancelFileEditBatch()}>取消批次预览</button></div>
    </section>}
    <section className="space-y-3 border-t border-line pt-4" aria-label="批量文本历史"><h3 className="font-semibold">批次历史与恢复</h3><p className="text-xs">恢复只接受当前仍与该批次写入版一致的文件；外部改动、已是原文或未执行的条目不会恢复。恢复也要预览确认并新增版本。记录可在单文件历史中核验、导出和删除；这里只显示仍保留的记录。</p>
      {batches.map(batch => <details key={batch.id} className="rounded border border-line p-3"><summary className="cursor-pointer break-all text-sm">{batch.rows[0].directoryName} · {batch.rows.length}/{batch.rows[0].batch!.total} 条 · {new Date(batch.rows[0].createdAt).toLocaleString()} · {batch.id}</summary>
        <ul className="my-3 space-y-1 text-sm">{batch.rows.map(r => <li className="break-all" key={r.id}>{r.name} · {labels[r.status]}{r.error ? ' · ' + r.error : ''}{r.inspection ? ' · 核验：' + r.inspection.outcome : ''}</li>)}</ul>
        <div className="flex flex-wrap gap-2"><button className="work-command" disabled={busy || !directory} onClick={() => directory && void act(async () => { for (const r of batch.rows) { if (!mounted.current) return; await store.inspectFileEdit(directory, r.id, ack); } })}>核验批次文件</button><button className="work-command" disabled={busy || !directory || !!store.fileEditDraft || !!store.storageError} onClick={() => directory && void act(() => store.prepareFileEditBatch(directory, [], null, ack, batch.id))}>预览恢复批次原文</button><button className="work-command" onClick={() => download(batch.rows)}>导出批次记录（明文）</button></div>
      </details>)}
    </section>
  </div></section>;
}
