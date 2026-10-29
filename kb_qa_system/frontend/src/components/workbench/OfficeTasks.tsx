import { lazy, Suspense, useState } from 'react';
import { DocumentTasks } from './DocumentTasks';
const ChartTasks = lazy(() => import('./ChartTasks').then(module => ({ default: module.ChartTasks })));
const OfficeToolTasks = lazy(() => import('./OfficeToolTasks').then(module => ({ default: module.OfficeToolTasks })));
const Workflows = lazy(() => import('./Workflows').then(module => ({ default: module.Workflows })));
const WebDesigner = lazy(() => import('./WebDesigner').then(module => ({ default: module.WebDesigner })));
const AgentStudio = lazy(() => import('./AgentStudio').then(module => ({ default: module.AgentStudio })));
const CapabilityStudio = lazy(() => import('./CapabilityStudio').then(m => ({ default: m.CapabilityStudio })));
const ImageStudio = lazy(() => import('./ImageStudio').then(m => ({ default: m.ImageStudio })));
const tabs = { document: '文档生成', long: '长任务', image: '图片生成', chart: '图表工具', web: '网页设计', agents: '智能体仓库', resources: '资源仓库' };
type Tab = keyof typeof tabs;
function LongTasks() {
  const [view, setView] = useState<'workflow' | 'tools'>('workflow'), [visited, setVisited] = useState(false);
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col"><div className="flex flex-wrap gap-2 border-b border-line px-4 py-2" role="tablist" aria-label="长任务模式">
    <button className="work-command" role="tab" aria-selected={view === 'workflow'} onClick={() => setView('workflow')}>流程编排</button>
    <button className="work-command" role="tab" aria-selected={view === 'tools'} onClick={() => { setView('tools'); setVisited(true); }}>自主多步骤与历史</button>
  </div><div className={`${view === 'workflow' ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-1 flex-col`}><Workflows /></div>{visited && <div className={`${view === 'tools' ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-1 flex-col`}><OfficeToolTasks /></div>}</div>;
}

export function OfficeTasks() {
  const [kind, setKind] = useState<Tab>('document'), [visited, setVisited] = useState<Tab[]>(['document']);
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    <div className="flex shrink-0 flex-wrap gap-2 border-b border-line px-4 py-2" role="tablist" aria-label="任务类型">
      {Object.entries(tabs).map(([id, label]) => <button key={id} role="tab" aria-selected={kind === id} className={`work-command ${kind === id ? 'bg-muted' : ''}`} onClick={() => { setKind(id as Tab); setVisited(v => v.includes(id as Tab) ? v : [...v, id as Tab]); }}>{label}</button>)}
    </div>
    {visited.map(id => <div key={id} role="tabpanel" aria-label={tabs[id]} className={`${kind === id ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-1 flex-col`}><Suspense fallback={<p className="p-4 text-sm">正在加载办公工具…</p>}>{id === 'document' ? <DocumentTasks /> : id === 'long' ? <LongTasks /> : id === 'image' ? <ImageStudio /> : id === 'chart' ? <ChartTasks /> : id === 'web' ? <WebDesigner /> : id === 'agents' ? <AgentStudio /> : <CapabilityStudio />}</Suspense></div>)}
  </div>;
}
