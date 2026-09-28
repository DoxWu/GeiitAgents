import { lazy, Suspense, useState } from 'react';
import { DocumentTasks } from './DocumentTasks';
const ChartTasks = lazy(() => import('./ChartTasks').then(module => ({ default: module.ChartTasks })));
const OfficeToolTasks = lazy(() => import('./OfficeToolTasks').then(module => ({ default: module.OfficeToolTasks })));

export function OfficeTasks() {
  const [kind, setKind] = useState<'document' | 'chart' | 'tools'>('document');
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    <div className="flex shrink-0 flex-wrap gap-2 border-b border-line px-4 py-2" role="tablist" aria-label="任务类型">
      <button role="tab" aria-selected={kind === 'document'} className={`work-command ${kind === 'document' ? 'bg-muted' : ''}`} onClick={() => setKind('document')}>文档生成</button>
      <button role="tab" aria-selected={kind === 'chart'} className={`work-command ${kind === 'chart' ? 'bg-muted' : ''}`} onClick={() => setKind('chart')}>图表工具</button>
      <button role="tab" aria-selected={kind === 'tools'} className={`work-command ${kind === 'tools' ? 'bg-muted' : ''}`} onClick={() => setKind('tools')}>多步骤任务</button>
    </div>
    {kind === 'document' ? <DocumentTasks /> : <Suspense fallback={<p className="p-4 text-sm">正在加载办公工具…</p>}>{kind === 'chart' ? <ChartTasks /> : <OfficeToolTasks />}</Suspense>}
  </div>;
}
