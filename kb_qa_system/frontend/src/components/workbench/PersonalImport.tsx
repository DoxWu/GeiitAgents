import { useEffect, useRef, useState } from 'react';
import { useWorkbenchStore } from '@/store/workbenchStore';
import type { PersonalImportAction, PersonalImportMergeField, PersonalImportRow } from '@/personal/import';
import type { PersonalDraft } from '@/personal/itemDraft';
import type { PersonalItem } from '@/personal/items';

const statusLabels: Record<PersonalImportRow['status'], string> = { new: '新记录', duplicate: '内容与状态一致', similar: '其他标识已有相同内容', conflict: '同一标识内容不同', 'draft-conflict': '本机已有编辑草稿', 'kind-conflict': '同一标识类型不同' };
const actionLabels: Record<PersonalImportAction, string> = { skip: '跳过，保留本机内容', add: '新增记录（保留原标识）', copy: '另存独立副本', replace: '用文件版本替换（含归档状态）', merge: '按字段合并到本机' };
const mergeLabels: Record<PersonalImportMergeField, string> = { title: '标题', content: '正文', tags: '标签', todo: '待办状态、优先级、截止与完成时间', archivedAt: '归档状态' };
function RecordPreview({ row }: { row: PersonalItem }) {
  return <div className="space-y-2 text-xs"><p>类型：{row.kind === 'note' ? '笔记' : '待办'} · 修订 {row.revision} · {row.archivedAt ? `归档：${row.archivedAt}` : '未归档'}</p>
    <p className="break-all">标识：{row.id} · 创建：{row.createdAt} · 更新：{row.updatedAt}</p>
    {row.kind === 'todo' && <p>状态：{row.status} · 优先级：{row.priority} · 截止（UTC）：{row.dueAt || '未设置'} · 完成：{row.completedAt || '未完成'}</p>}
    <p>标签：{row.tags.join('、') || '无'}</p><p className="break-words font-medium">{row.title}</p><pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words">{row.content || '（空正文）'}</pre></div>;
}
export function PersonalImport({ onBack }: { onBack: () => void }) {
  const store = useWorkbenchStore(), preview = store.personalImportPreview, result = store.personalImportResult;
  const [choices, setChoices] = useState<Record<string, PersonalImportAction>>({}), [mergeFields, setMergeFields] = useState<Record<string, PersonalImportMergeField[]>>({}), [acknowledged, setAcknowledged] = useState(false), [error, setError] = useState(''), [page, setPage] = useState(0);
  const mounted = useRef(false), request = useRef(0);
  useEffect(() => { const pending = request; mounted.current = true; return () => { mounted.current = false; pending.current++; useWorkbenchStore.getState().cancelPersonalImport(); }; }, []);
  useEffect(() => { setChoices(Object.fromEntries((preview?.rows ?? []).map(row => [row.id, row.defaultAction]))); setMergeFields({}); setAcknowledged(false); setPage(0); }, [preview]);
  async function perform(action: () => Promise<void>) {
    const token = ++request.current; setError('');
    try { await action(); }
    catch (e) { if (mounted.current && token === request.current) setError(e instanceof Error ? e.message : '导入失败，请保留原文件。'); }
  }
  const selected = preview?.rows.filter(row => choices[row.id] && choices[row.id] !== 'skip').length ?? 0;
  const replaces = preview?.rows.filter(row => choices[row.id] === 'replace').length ?? 0;
  const merges = preview?.rows.filter(row => choices[row.id] === 'merge').length ?? 0;
  const invalidMerge = preview?.rows.some(row => choices[row.id] === 'merge' && !mergeFields[row.id]?.length) ?? false;
  function setChoice(id: string, action: PersonalImportAction) {
    if (action === 'merge' && choices[id] !== 'merge') setMergeFields(current => ({ ...current, [id]: [] }));
    setChoices(current => ({ ...current, [id]: action })); setAcknowledged(false);
  }
  function setMergeField(id: string, field: PersonalImportMergeField, checked: boolean) {
    setMergeFields(current => {
      const fields = new Set(current[id] ?? []);
      if (checked) fields.add(field); else fields.delete(field);
      return { ...current, [id]: [...fields] };
    });
    setAcknowledged(false);
  }
  return <section aria-label="导入笔记与待办 JSON" className="min-h-0 flex-1 overflow-auto p-4 sm:p-6"><div className="mx-auto max-w-4xl space-y-5">
    <div className="flex flex-wrap items-center gap-3"><button className="work-command" disabled={store.personalImportBusy} onClick={onBack}>返回本机记录</button><h1 className="text-xl font-semibold">导入笔记与待办 JSON</h1></div>
    <p className="text-sm text-ink-secondary">选择本应用导出的正式记录 JSON 或“当前草稿”JSON。文件只在本机读取，不上传、不调用模型、不创建邮件提醒。读取和预检查不会修改记录；整库加密文件请到工作台备份恢复。</p>
    <label className="work-label">笔记/待办 JSON 文件（最多 16 MiB）<input aria-label="笔记待办导入文件" type="file" accept=".json,application/json" disabled={store.personalImportBusy || Boolean(result && !result.saved)} onChange={e => {
      const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
      void perform(() => store.preparePersonalImport(file, file.name));
    }} /></label>
    {store.personalImportBusy && <p role="status">正在读取、预检查或加密保存…</p>}
    {store.personalImportBusy && !preview && !result && <button className="work-command" onClick={() => { request.current++; store.cancelPersonalImport(); setError(''); }}>取消读取文件</button>}
    {preview && <section aria-label="笔记待办导入预检查" className="space-y-4 rounded border border-line p-4">
      <h2 className="break-all font-semibold">{preview.name} · {preview.kind === 'draft' ? '原始编辑草稿' : `${preview.rows.length} 条正式记录`}</h2>
      {preview.exportedAt && <p className="text-xs text-ink-secondary">文件声明的导出时间：{preview.exportedAt}，不是可信的版本优先级依据。</p>}
      <p className="text-sm">已选 {selected} 条，其中替换 {replaces} 条、字段合并 {merges} 条。本机现有 {store.personalItems.length}/500 条正式记录、{store.personalDrafts.length}/100 条草稿。</p>
      <p className="text-xs text-ink-secondary">一致/冲突记录默认跳过；不同标识的相同内容也提示重复。有草稿或类型不同的同标识记录只能跳过或另存。替换与字段合并均保留本机标识/创建时间并增加本机修订；时间与归档状态以预览及字段选择为准，不比较两台设备的修订大小。</p>
      {preview.kind === 'draft' && <p className="text-sm">草稿将使用新标识、保留原始输入和时区，作为独立未保存记录；不覆盖旧草稿、不自动变为正式记录。标题为空或截止输入未完成仍可恢复。</p>}
      <fieldset disabled={store.personalImportBusy} className="space-y-3">
        <div className="flex flex-wrap gap-2"><button className="work-command" onClick={() => { setChoices(Object.fromEntries(preview.rows.map(row => [row.id, row.defaultAction]))); setAcknowledged(false); }}>恢复默认选择</button>
          <button className="work-command" onClick={() => { setChoices(Object.fromEntries(preview.rows.map(row => [row.id, 'skip']))); setAcknowledged(false); }}>全部跳过</button></div>
        {preview.rows.slice(page * 20, (page + 1) * 20).map((row, i) => <article key={row.id} className="space-y-3 rounded border border-line p-3" aria-label={`导入条目 ${page * 20 + i + 1}`}>
          <h3 className="break-words font-medium">{page * 20 + i + 1}. {row.title || '（未命名草稿）'} · {statusLabels[row.status]}</h3>
          {row.matchedTitle && row.status === 'similar' && <p className="text-xs">已有相同内容：{row.matchedTitle}</p>}
          <label className="work-label">处理方式<select aria-label={`导入处理方式 ${page * 20 + i + 1}`} className="work-input" value={choices[row.id] || 'skip'} onChange={e => setChoice(row.id, e.target.value as PersonalImportAction)}>{row.actions.map(action => <option key={action} value={action}>{preview.kind === 'draft' && action === 'copy' ? '恢复为独立新草稿' : actionLabels[action]}</option>)}</select></label>
          {preview.kind === 'records' && choices[row.id] === 'merge' && <fieldset className="grid gap-2 rounded border border-line p-3"><legend className="px-1 text-sm font-medium">选择采用文件中的字段</legend><p className="text-xs text-ink-secondary">未勾选的字段保留本机值；至少选择一项。待办相关字段作为一组，归档状态单独选择。</p>
            {(row.kind === 'todo' ? ['title', 'content', 'tags', 'todo', 'archivedAt'] as const : ['title', 'content', 'tags', 'archivedAt'] as const).map(field => <label key={field} className="flex items-start gap-2 text-sm"><input type="checkbox" checked={mergeFields[row.id]?.includes(field) ?? false} onChange={e => setMergeField(row.id, field, e.target.checked)} /><span>采用文件中的{mergeLabels[field]}</span></label>)}
          </fieldset>}
          <details><summary className="cursor-pointer text-sm">比较文件内容与本机内容</summary><div className="mt-3 grid min-w-0 gap-4 sm:grid-cols-2">
            <div className="min-w-0"><h4 className="mb-2 text-sm font-medium">文件内容</h4>{preview.kind === 'records' ? <RecordPreview row={row.source as PersonalItem} /> : <>
              <p className="text-xs">时区：{(row.source as PersonalDraft).timezone} · 原始截止输入：{(row.source as PersonalDraft).dueText || '未设置'}</p>
              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(row.source, null, 2)}</pre></>}</div>
            <div className="min-w-0"><h4 className="mb-2 text-sm font-medium">本机内容</h4>{row.current ? <RecordPreview row={row.current} /> : <p className="text-xs">不替换本机正式记录。</p>}</div>
          </div></details>
        </article>)}
        {preview.rows.length > 20 && <div className="flex items-center gap-3"><button className="work-command" disabled={!page} onClick={() => setPage(p => p - 1)}>上一页导入条目</button><span className="text-sm">{page + 1} / {Math.ceil(preview.rows.length / 20)}</span><button className="work-command" disabled={(page + 1) * 20 >= preview.rows.length} onClick={() => setPage(p => p + 1)}>下一页导入条目</button></div>}
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} />我已核对所选条目及替换内容，确认写入本机加密库</label>
        <div className="flex flex-wrap gap-2"><button className="work-command bg-brand text-white" disabled={!acknowledged || !selected || invalidMerge || Boolean(store.storageError)} onClick={() => { setAcknowledged(false); void perform(() => store.commitPersonalImport(preview.id, preview.rows.map(row => ({ id: row.id, action: choices[row.id] || 'skip', ...(choices[row.id] === 'merge' ? { mergeFields: mergeFields[row.id] } : {}) })))); }}>确认导入所选条目</button>
          <button className="work-command" onClick={() => { request.current++; store.cancelPersonalImport(); setError(''); }}>取消导入预检查</button></div>
      </fieldset>
    </section>}
    {result && <section aria-label="笔记待办导入结果" className="space-y-3 rounded border border-line p-4"><h2 className="font-medium">{result.saved ? '导入已加密保存' : '导入结果已在内存，尚未确认持久保存'}</h2>
      <p className="text-sm">新增 {result.added} 条 · 替换 {result.replaced} 条 · 合并 {result.merged} 条 · 新草稿 {result.drafts} 条 · 跳过 {result.skipped} 条</p>
      {!result.saved && <><p className="text-sm text-danger">请重试保存或使用工作台加密备份保护当前内存数据。重试只保存当前快照，不再次创建副本；若刷新或锁库前仍无法保存，只能恢复最后成功写入的数据。</p><button className="work-command" disabled={store.personalImportBusy} onClick={() => void perform(() => store.retryPersonalImport())}>重试保存导入结果</button></>}
      {result.saved && <button className="work-command" onClick={onBack}>查看导入后的本机记录</button>}
    </section>}
    {store.storageError && !result && <button className="work-command" disabled={store.personalImportBusy} onClick={() => void perform(() => store.retryStorage())}>重试本机保存</button>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </div></section>;
}
