import { useMemo, useState } from 'react';
import { compareArtifactText } from '@/officeTasks/artifactDiff';
import type { WorkArtifact } from '@/types/workbench';

export function ArtifactComparison({ versions, target }: { versions: WorkArtifact[]; target: WorkArtifact }) {
  const alternatives = versions.filter(item => item.id !== target.id);
  const [baseId, setBaseId] = useState(target.parentArtifactId ?? alternatives[0]?.id ?? '');
  const base = alternatives.find(item => item.id === baseId) ?? alternatives[0];
  if (!base) return <p className="mt-4 text-sm">至少需要两个版本才能比较。</p>;
  return <section aria-label="版本对比" className="mt-4 rounded border border-line p-3">
    <label className="work-label">对比基准<select aria-label="对比基准" className="work-input" value={base.id} onChange={e => setBaseId(e.target.value)}>
      {alternatives.map(item => <option key={item.id} value={item.id}>版本 {item.version}</option>)}
    </select></label>
    <p className="my-3 text-sm">版本 {base.version} → 版本 {target.version}（当前所选）。比较已保存的 Markdown 原文，包含空白和换行。</p>
    <DiffView key={`${base.id}:${target.id}`} before={base.content} after={target.content} />
  </section>;
}

function DiffView({ before, after }: { before: string; after: string }) {
  const result = useMemo(() => compareArtifactText(before, after), [before, after]);
  const [showEqual, setShowEqual] = useState(false);
  const [page, setPage] = useState(0);
  const rows = useMemo(() => showEqual ? result.rows : result.rows.filter(row => row.kind !== 'equal'), [result, showEqual]);
  if (result.identical) return <p>两个版本内容完全相同。</p>;
  if (result.mode === 'too-large') return <p>两个版本内容不同；合计超过 400000 字符或 10000 行，未展开逐行对比。请下载两个 Markdown 文件进行完整比较。</p>;
  const pages = Math.max(1, Math.ceil(rows.length / 100));
  return <>
    <p className="text-sm">新增 {result.added} 行 · 删除 {result.removed} 行</p>
    {result.mode === 'coarse' && <p className="mt-2 text-xs text-ink-secondary">差异范围较大，中间区域按整段替换显示；行数不代表最小改动量。</p>}
    <label className="my-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={showEqual} onChange={e => { setShowEqual(e.target.checked); setPage(0); }} />显示未变化行</label>
    <div className="max-h-96 overflow-auto rounded border border-line" aria-label="差异行">
      {rows.slice(page * 100, (page + 1) * 100).map((row, index) => {
        const ending = row.text.endsWith('\r\n') ? 'CRLF' : row.text.endsWith('\n') ? 'LF' : '无行末换行';
        const text = row.text.replace(/\r?\n$/, '');
        return <div key={page * 100 + index} className={`grid grid-cols-[5.5rem_minmax(0,1fr)] border-b border-line p-2 text-xs ${row.kind === 'add' ? 'bg-green-500/10' : row.kind === 'remove' ? 'bg-red-500/10' : ''}`}>
          <span className="text-ink-secondary">{row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : '='} {row.beforeLine ?? '—'} / {row.afterLine ?? '—'}</span>
          <div className="min-w-0"><pre className="whitespace-pre-wrap break-all font-mono">{text.slice(0, 2000) || ' '}</pre>
            <span className="text-ink-tertiary">{ending}{text.length > 2000 ? ' · 此行仅显示前 2000 字符，请下载查看完整内容' : ''}</span></div>
        </div>;
      })}
    </div>
    <p className="mt-2 text-xs text-ink-secondary">行号：基准 / 所选。+ 新增，− 删除，= 未变。每页最多 100 行。</p>
    {pages > 1 && <div className="mt-2 flex flex-wrap items-center gap-3">
      <button className="work-command" disabled={page === 0} onClick={() => setPage(value => value - 1)}>上一页差异</button>
      <span className="text-xs">第 {page + 1} / {pages} 页</span>
      <button className="work-command" disabled={page + 1 >= pages} onClick={() => setPage(value => value + 1)}>下一页差异</button>
    </div>}
  </>;
}
