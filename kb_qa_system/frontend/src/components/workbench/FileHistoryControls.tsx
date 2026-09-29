import { useState, type ReactNode } from 'react';
import type { HistoryFilter } from '@/fileOrganizer/historyView';

interface HistoryControlsProps extends HistoryFilter {
  label: string;
  total: number;
  page: number;
  pages: number;
  statuses: Record<string, string>;
  busy: boolean;
  changeFilter: (filter: HistoryFilter) => void;
  setPage: (page: number) => void;
}
export function FileHistoryControls({ label, total, page, pages, statuses, busy, query, status, changeFilter, setPage }: HistoryControlsProps) {
  return <fieldset disabled={busy} className="my-3 space-y-3">
    <legend className="sr-only">{label}筛选与分页</legend>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="work-label">{label}搜索<input type="search" className="work-input" maxLength={200} value={query} placeholder="文件名、目录或记录编号" onChange={e => changeFilter({ query: e.target.value, status })} /></label>
      <label className="work-label">{label}状态<select className="work-input" value={status} onChange={e => changeFilter({ query, status: e.target.value })}>
        <option value="">全部状态</option>{Object.entries(statuses).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
      </select></label>
    </div>
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span aria-live="polite">{label}：共 {total} 条 · 第 {page}/{pages} 页 · 每页 10 条</span>
      <nav className="flex flex-wrap gap-2" aria-label={label + '分页'}>
        <button className="work-command" disabled={page === 1} onClick={() => setPage(1)}>首页</button>
        <button className="work-command" disabled={page === 1} onClick={() => setPage(page - 1)}>上一页</button>
        <button className="work-command" disabled={page === pages} onClick={() => setPage(page + 1)}>下一页</button>
        <button className="work-command" disabled={page === pages} onClick={() => setPage(pages)}>末页</button>
      </nav>
      <button className="work-command" disabled={!query && !status} onClick={() => changeFilter({ query: '', status: '' })}>清除筛选</button>
    </div>
    {!total && <p className="text-sm">没有符合条件的历史记录。</p>}
  </fieldset>;
}

export function FileHistoryDetails({ summary, children }: { summary: ReactNode; children: () => ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  return <details className="mt-3 rounded border border-line p-3" onToggle={e => setExpanded(e.currentTarget.open)}>
    <summary className="cursor-pointer break-all text-sm">{summary}</summary>
    {expanded && children()}
  </details>;
}

export function FileChangeList<T>({ items, render }: { items: T[]; render: (item: T) => ReactNode }) {
  const [page, setPage] = useState(1), pages = Math.max(1, Math.ceil(items.length / 50));
  const current = Math.min(page, pages);
  if (current !== page) setPage(current);
  return <div>
    <p className="mt-2 text-xs">文件明细：共 {items.length} 个 · 第 {current}/{pages} 页 · 每页最多 50 个。核验、撤销和导出仍处理整条记录。</p>
    {pages > 1 && <nav aria-label="文件明细分页" className="mt-2 flex gap-2">
      <button className="work-command" disabled={current === 1} onClick={() => setPage(current - 1)}>上一组文件</button>
      <button className="work-command" disabled={current === pages} onClick={() => setPage(current + 1)}>下一组文件</button>
    </nav>}
    <ul className="mt-2 text-xs">{items.slice((current - 1) * 50, current * 50).map(render)}</ul>
  </div>;
}
