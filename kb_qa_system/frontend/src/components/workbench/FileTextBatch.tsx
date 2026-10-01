import { useEffect, useMemo, useRef, useState } from 'react';
import type { OrganizerDirectoryHandle } from '@/fileOrganizer/apply';
import { pickOrganizerDirectory } from '@/fileOrganizer/directory';
import { MAX_BATCH_RULES, type TextBatchConfig, type TextBatchRule, type TextBatchRow, type TextBatchRules } from '@/fileOrganizer/textBatch';
import { textBytes, type FileEditVersion } from '@/fileOrganizer/textEdit';
import { compareArtifactText } from '@/officeTasks/artifactDiff';
import { useWorkbenchStore } from '@/store/workbenchStore';
import { selectTextBatches } from '@/fileOrganizer/historyView';
import { useFileHistory } from './useFileHistory';
import { FileHistoryControls, FileHistoryDetails } from './FileHistoryControls';

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
  const [rules, setRules] = useState<TextBatchRules>([{ find: '', replacement: '', newline: 'keep' }]);
  const [perFileRules, setPerFileRules] = useState<Record<string, TextBatchRules>>({}), [ruleFile, setRuleFile] = useState('');
  const [ack, setAck] = useState(false), [confirmed, setConfirmed] = useState(false), [selected, setSelected] = useState<string[]>([]), [view, setView] = useState('');
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const mounted = useRef(false), working = useRef(false), handles = useRef(new Set<OrganizerDirectoryHandle>());
  useEffect(() => { mounted.current = true; const grants = handles.current; return () => { mounted.current = false; useWorkbenchStore.getState().cancelFileEditBatch(); for (const d of grants) d.release?.(); grants.clear(); }; }, []);
  useEffect(() => { const rows = preview?.rows.filter(r => r.draft && r.after && !r.error) ?? []; setSelected(rows.map(r => r.id)); setView(rows[0]?.id || ''); setConfirmed(false); }, [preview]);
  const busy = loading || store.organizerBusy;
  const history = useFileHistory(store.fileEditVersions, selectTextBatches);
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
      if (directory && handles.current.delete(directory)) directory.release?.(); setDirectory(d); setNames(list.sort((a, b) => a.localeCompare(b))); setFiles([]); setPerFileRules({}); setRuleFile(''); setAck(false);
    } catch (e) { if (handles.current.delete(d)) d.release?.(); throw e; }
  }
  const editingRules = ruleFile && perFileRules[ruleFile] ? perFileRules[ruleFile] : rules;
  const ruleLabel = ruleFile && perFileRules[ruleFile] ? '文件' : '批量';
  function setEditingRules(update: (current: TextBatchRules) => TextBatchRules) {
    store.cancelFileEditBatch();
    if (ruleFile && perFileRules[ruleFile]) setPerFileRules(current => ({ ...current, [ruleFile]: update(current[ruleFile]) }));
    else setRules(update);
  }
  function changeRule(index: number, next: TextBatchRule) { setEditingRules(current => current.map((rule, i) => i === index ? next : rule)); }
  function addRule() { if (editingRules.length >= MAX_BATCH_RULES) return; setEditingRules(current => [...current, { find: '', replacement: '', newline: current[0].newline }]); }
  function removeRule(index: number) { if (editingRules.length <= 1) return; setEditingRules(current => current.filter((_, i) => i !== index)); }
  function toggleFileRules(enabled: boolean) {
    if (!ruleFile) return;
    store.cancelFileEditBatch();
    setPerFileRules(current => {
      if (enabled) return { ...current, [ruleFile]: rules.map(rule => ({ ...rule })) };
      const next = { ...current }; delete next[ruleFile]; return next;
    });
  }
  function changeFiles(next: string[]) {
    store.cancelFileEditBatch(); setFiles(next);
    setPerFileRules(current => Object.fromEntries(Object.entries(current).filter(([name]) => next.includes(name))));
    if (!next.includes(ruleFile)) setRuleFile(next[0] ?? '');
  }
  return <section className="min-h-0 flex-1 overflow-auto p-4 sm:p-6" aria-label="批量文本编辑"><div className="mx-auto max-w-5xl space-y-4">
    <h2 className="font-semibold">批量查找与替换</h2><p className="text-sm text-ink-secondary">在已选目录中逐个选择最多 20 个 UTF-8 MD/TXT 文件，每个最多 256 KiB。最多 5 条规则按顺序进行字面替换，每条可选择是否区分大小写，后续规则会处理前一条的结果。可为单个文件覆盖默认规则。先预览，确认后保存全部前后版本，再逐个写入。中途停止或失败会保留已完成文件，不自动回滚整批。</p>
    <fieldset disabled={busy} className="space-y-3">
      <button className="work-command" onClick={() => void act(pick)}>选择批量编辑目录</button><p className="break-all text-sm">批量目录：{directory?.name || '尚未选择'}</p>
      {directory && !directory.identity && <label className="flex gap-2 text-sm"><input type="checkbox" checked={ack} onChange={e => { setAck(e.target.checked); setConfirmed(false); }} />我确认批量编辑与恢复使用的是正确目录。浏览器无法持久验证目录身份。</label>}
      {names.length > 0 && <div className="max-h-48 overflow-auto rounded border border-line p-3" aria-label="批量文件选择">{names.map(name => <label key={name} className="flex items-start gap-2 break-all text-sm"><input type="checkbox" aria-label={'批量选择文件：' + name} checked={files.includes(name)} disabled={!files.includes(name) && files.length >= 20} onChange={e => changeFiles(e.target.checked ? [...files, name] : files.filter(n => n !== name))} />{name}{perFileRules[name] && <span className="text-ink-secondary">（独立规则）</span>}</label>)}</div>}
      {files.length > 0 && <div className="grid gap-3 sm:grid-cols-2"><label className="work-label">编辑规则所应用的文件<select aria-label="编辑规则所应用的文件" className="work-input" value={ruleFile} onChange={e => setRuleFile(e.target.value)}>{files.map(name => <option key={name} value={name}>{name}</option>)}</select></label><label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" aria-label="为此文件单独设置规则" checked={Boolean(ruleFile && perFileRules[ruleFile])} onChange={e => toggleFileRules(e.target.checked)} />为此文件单独设置规则</label></div>}
      <div className="space-y-3" aria-label="批量替换规则">{editingRules.map((rule, index) => <div className="grid gap-3 border border-line p-3 md:grid-cols-2" key={index}>
        <label className="work-label">{index ? `${ruleLabel}查找内容 ${index + 1}` : `${ruleLabel}查找内容`}<textarea aria-label={index ? `${ruleLabel}查找内容 ${index + 1}` : `${ruleLabel}查找内容`} className="work-input h-24" maxLength={10000} value={rule.find} onChange={e => changeRule(index, { ...rule, find: e.target.value })} /></label>
        <label className="work-label">{index ? `${ruleLabel}替换内容（可为空） ${index + 1}` : `${ruleLabel}替换内容（可为空）`}<textarea aria-label={index ? `${ruleLabel}替换内容（可为空） ${index + 1}` : `${ruleLabel}替换内容（可为空）`} className="work-input h-24" maxLength={10000} value={rule.replacement} onChange={e => changeRule(index, { ...rule, replacement: e.target.value })} /></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label={index ? `区分大小写 ${index + 1}` : '区分大小写'} checked={rule.caseSensitive !== false} onChange={e => changeRule(index, { ...rule, caseSensitive: e.target.checked })} />区分大小写</label>
        {index > 0 && <button type="button" className="work-command justify-self-start" onClick={() => removeRule(index)}>移除规则 {index + 1}</button>}
      </div>)}</div>
      <div className="flex flex-wrap items-end gap-2"><label className="work-label min-w-[14rem]">{ruleFile && perFileRules[ruleFile] ? '此文件写入换行' : '批量写入换行'}<select aria-label={ruleFile && perFileRules[ruleFile] ? '此文件写入换行' : '批量写入换行'} className="work-input" value={editingRules[0].newline} onChange={e => { const newline = e.target.value as TextBatchRule['newline']; setEditingRules(current => current.map(rule => ({ ...rule, newline }))); }}><option value="keep">保留各文件格式（混合换行需另选）</option><option value="lf">LF</option><option value="crlf">CRLF</option><option value="cr">CR</option></select></label><button type="button" className="work-command" disabled={editingRules.length >= MAX_BATCH_RULES} onClick={addRule}>增加替换规则（{editingRules.length}/{MAX_BATCH_RULES}）</button></div>
      <button className="work-command" disabled={!directory || !files.length || rules.some(rule => !rule.find) || Object.values(perFileRules).some(fileRules => fileRules.some(rule => !rule.find)) || !!store.fileEditDraft || !!store.storageError} onClick={() => directory && void act(() => store.prepareFileEditBatch(directory, files, { defaultRules: rules, perFileRules } satisfies TextBatchConfig, ack))}>读取并预览批次</button>
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
      <p className="text-xs">搜索与状态需匹配同一文件，命中后显示完整批次；核验、恢复和导出仍使用整组保留记录。</p>
      <FileHistoryControls {...history} label="批次历史" statuses={labels} busy={busy} />
      {history.rows.map(batch => <FileHistoryDetails key={batch.id} summary={<>{batch.rows[0].directoryName} · {batch.rows.length}/{batch.rows[0].batch!.total} 条 · {new Date(batch.createdAt).toLocaleString()} · {batch.id}</>}>{() => <>
        <ul className="my-3 space-y-1 text-sm">{batch.rows.map(r => <li className="break-all" key={r.id}>{r.name} · {labels[r.status]}{r.error ? ' · ' + r.error : ''}{r.inspection ? ' · 核验：' + r.inspection.outcome : ''}</li>)}</ul>
        <div className="flex flex-wrap gap-2"><button className="work-command" disabled={busy || !directory} onClick={() => directory && void act(async () => { for (const r of batch.rows) { if (!mounted.current) return; await store.inspectFileEdit(directory, r.id, ack); } })}>核验批次文件</button><button className="work-command" disabled={busy || !directory || !!store.fileEditDraft || !!store.storageError} onClick={() => directory && void act(() => store.prepareFileEditBatch(directory, [], null, ack, batch.id))}>预览恢复批次原文</button><button className="work-command" onClick={() => download(batch.rows)}>导出批次记录（明文）</button></div>
      </>}</FileHistoryDetails>)}
    </section>
  </div></section>;
}
