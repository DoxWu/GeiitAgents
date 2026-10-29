import { useId, useRef, useState } from 'react';
import { isBranchNode, NODE_LABELS, type WorkflowDefinition } from '@/workflows/definition';

export function WorkflowCanvas({ definition, selected, onSelect, onMove, onAutoLayout, onConnect, onDisconnect }: {
  definition: WorkflowDefinition; selected: string; onSelect: (id: string) => void; onMove: (id: string, x: number, y: number) => void; onAutoLayout: () => void;
  onConnect?: (edge: WorkflowDefinition['edges'][number]) => void; onDisconnect?: (edge: WorkflowDefinition['edges'][number]) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [view, setView] = useState<'canvas' | 'list'>('canvas');
  const [pending, setPending] = useState<{ from: string; when?: 'true' | 'false' } | null>(null);
  const [preview, setPreview] = useState<{ x: number; y: number } | null>(null);
  const world = useRef<HTMLDivElement>(null), marker = useId().replace(/:/g, '');
  const linkMoved = useRef(false), ignoreClick = useRef(false);
  const outputY = (node: WorkflowDefinition['nodes'][number], when?: 'true' | 'false') => node.y + (isBranchNode(node) ? when === 'true' ? 30 : 85 : 50);
  const curve = (x: number, y: number, tx: number, ty: number) => `M ${x} ${y} C ${x + 70} ${y}, ${tx - 70} ${ty}, ${tx} ${ty}`;
  const drag = useRef<{ id: string; pointer: number; x: number; y: number; startX: number; startY: number } | null>(null);
  const width = Math.max(780, ...definition.nodes.map(n => n.x + 250)), height = Math.max(340, ...definition.nodes.map(n => n.y + 135));
  const clamp = (value: number) => Math.round(Math.max(0, Math.min(2000, value)));
  return <div className="min-w-0 max-w-full overflow-hidden rounded border border-line bg-muted" aria-label="工作流画布" onKeyDown={e => { if (e.key === 'Escape') { setPending(null); setPreview(null); } }}>
    <div className="flex flex-wrap items-center gap-2 border-b border-line p-2" aria-label="画布工具">
      <button type="button" className="work-command" aria-pressed={view === 'canvas'} onClick={() => setView('canvas')}>流程画布</button><button type="button" className="work-command" aria-pressed={view === 'list'} onClick={() => setView('list')}>步骤列表</button>
      <button type="button" className="work-command" aria-label="缩小画布" disabled={zoom <= 0.6} onClick={() => setZoom(value => Math.max(0.6, Math.round((value - 0.1) * 10) / 10))}>−</button>
      <span className="text-sm text-ink-secondary" aria-label="画布缩放比例">{Math.round(zoom * 100)}%</span>
      <button type="button" className="work-command" aria-label="放大画布" disabled={zoom >= 1.5} onClick={() => setZoom(value => Math.min(1.5, Math.round((value + 0.1) * 10) / 10))}>+</button>
      <button type="button" className="work-command" aria-label="重置画布缩放" onClick={() => setZoom(1)}>重置缩放</button>
      <button type="button" className="work-command" aria-label="自动排列步骤" disabled={!definition.nodes.length} onClick={onAutoLayout}>自动排列步骤</button>
      {pending && <button type="button" className="work-command" onClick={() => { setPending(null); setPreview(null); }}>取消连线</button>}
    </div>
    {onConnect && <p className="border-b border-line px-3 py-2 text-xs text-ink-secondary" aria-live="polite">{pending ? '连线中：拖向或点击目标入口；Esc 取消。' : '从出口拖向入口，或依次点击两个端口连线。点击箭头可删除。'}</p>}
    {view === 'list' ? <div className="grid gap-2 p-3">{definition.nodes.map((node, i) => <button key={node.id} className={`min-w-0 border p-3 text-left ${selected === node.id ? 'border-brand' : 'border-line'}`} onClick={() => onSelect(node.id)}><strong>{i + 1}. {node.title}</strong><span className="ml-2 text-xs text-ink-secondary">{NODE_LABELS[node.kind]}</span><p className="mt-1 break-words text-xs">{definition.edges.filter(e => e.from === node.id).map(e => `${e.when === 'true' ? '满足' : e.when === 'false' ? '不满足' : '下一步'} → ${definition.nodes.find(n => n.id === e.to)?.title}`).join('；') || '无后续节点'}</p></button>)}</div> : <div className="max-h-[560px] overflow-auto" aria-label="画布滚动区域">
    <div className="relative" style={{ width: width * zoom, height: height * zoom }}>
    <div ref={world} className="absolute left-0 top-0" style={{ width, height, transform: `scale(${zoom})`, transformOrigin: 'top left' }}>
      <svg className="absolute inset-0" width={width} height={height} aria-label="步骤依赖连线">
        <defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
        {definition.edges.map(edge => {
          const from = definition.nodes.find(n => n.id === edge.from), to = definition.nodes.find(n => n.id === edge.to);
          return from && to ? <g key={edge.from + ':' + edge.to + ':' + (edge.when || '')} role="button" tabIndex={0} className="cursor-pointer text-ink-secondary" aria-label={`删除箭头 ${from.title} ${edge.when ?? ''} → ${to.title}`} onClick={() => onDisconnect?.(edge)} onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Delete') onDisconnect?.(edge); }}><path d={curve(from.x + 210, outputY(from, edge.when), to.x, to.y + 50)} fill="none" stroke="transparent" strokeWidth="18" /><path d={curve(from.x + 210, outputY(from, edge.when), to.x, to.y + 50)} fill="none" stroke="currentColor" strokeWidth="2" markerEnd={`url(#${marker})`} />{edge.when && <text x={from.x + 220} y={outputY(from, edge.when) - 5} fill="currentColor" fontSize="11">{edge.when === 'true' ? '满足' : '不满足'}</text>}</g> : null;
        })}
        {pending && preview && (() => { const node = definition.nodes.find(n => n.id === pending.from); return node ? <path d={curve(node.x + 210, outputY(node, pending.when), preview.x, preview.y)} fill="none" stroke="currentColor" strokeDasharray="6 5" /> : null; })()}
      </svg>
      {definition.nodes.map((node, index) => <div key={node.id} data-workflow-node={node.id} className={`absolute h-[110px] w-[210px] rounded border bg-surface p-3 shadow-sm ${selected === node.id ? 'border-brand ring-1 ring-brand' : 'border-line'}`} style={{ left: node.x, top: node.y }}>
        {onConnect && node.kind !== 'trigger' && <button type="button" data-workflow-input={node.id} className="absolute -left-2 top-[42px] h-4 w-4 rounded-full border-2 border-brand bg-surface" aria-label={`${node.title}入口`} onClick={() => { if (pending) onConnect({ ...pending, to: node.id }); setPending(null); setPreview(null); }} />}
        <button className="block w-full touch-none cursor-move text-left text-xs text-ink-secondary" aria-label={`移动步骤 ${index + 1}`}
          onPointerDown={e => { if (e.button !== 0) return; onSelect(node.id); drag.current = { id: node.id, pointer: e.pointerId, x: node.x, y: node.y, startX: e.clientX, startY: e.clientY }; e.currentTarget.setPointerCapture(e.pointerId); }}
          onPointerMove={e => { const d = drag.current; if (d?.id === node.id && d.pointer === e.pointerId) onMove(node.id, clamp(d.x + (e.clientX - d.startX) / zoom), clamp(d.y + (e.clientY - d.startY) / zoom)); }}
          onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
          onKeyDown={e => { const delta: Record<string, [number, number]> = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }; if (delta[e.key]) { e.preventDefault(); onMove(node.id, clamp(node.x + delta[e.key][0]), clamp(node.y + delta[e.key][1])); } }}>步骤 {index + 1} · 拖动 / 方向键移动</button>
        <button className="mt-2 block w-full truncate text-left font-medium" aria-label={`编辑步骤 ${index + 1}`} onClick={() => onSelect(node.id)}>{node.title}</button>
        <p className="mt-1 text-xs text-ink-secondary">{NODE_LABELS[node.kind]}</p>
        {onConnect && (isBranchNode(node) ? ['true', 'false'] as const : [undefined]).map(when => <button key={when ?? 'out'} type="button" className="absolute -right-2 h-4 w-4 touch-none rounded-full border-2 border-brand bg-surface" style={{ top: outputY(node, when) - node.y - 8 }} aria-label={`${node.title}${when === 'true' ? '满足' : when === 'false' ? '不满足' : ''}出口`} onClick={() => { if (ignoreClick.current) { ignoreClick.current = false; return; } setPending({ from: node.id, ...(when ? { when } : {}) }); }} onPointerDown={e => { if (e.button !== 0) return; linkMoved.current = false; setPending({ from: node.id, ...(when ? { when } : {}) }); e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={e => { if (!e.currentTarget.hasPointerCapture(e.pointerId)) return; linkMoved.current = true; const r = world.current!.getBoundingClientRect(); setPreview({ x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom }); }} onPointerCancel={() => { setPending(null); setPreview(null); }} onPointerUp={e => { if (!linkMoved.current) return; ignoreClick.current = true; const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-workflow-input]'); if (target?.dataset.workflowInput) onConnect({ from: node.id, to: target.dataset.workflowInput, ...(when ? { when } : {}) }); setPending(null); setPreview(null); setTimeout(() => { ignoreClick.current = false; }, 0); }} />)}
      </div>)}
    </div></div></div>}
  </div>;
}
