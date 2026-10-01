import { useRef, useState } from 'react';
import { NODE_LABELS, type WorkflowDefinition } from '@/workflows/definition';

export function WorkflowCanvas({ definition, selected, onSelect, onMove, onAutoLayout }: {
  definition: WorkflowDefinition; selected: string; onSelect: (id: string) => void; onMove: (id: string, x: number, y: number) => void; onAutoLayout: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  const drag = useRef<{ id: string; pointer: number; x: number; y: number; startX: number; startY: number } | null>(null);
  const width = Math.max(780, ...definition.nodes.map(n => n.x + 250)), height = Math.max(340, ...definition.nodes.map(n => n.y + 135));
  const clamp = (value: number) => Math.round(Math.max(0, Math.min(2000, value)));
  return <div className="max-w-full overflow-hidden rounded border border-line bg-muted" aria-label="工作流画布">
    <div className="flex flex-wrap items-center gap-2 border-b border-line p-2" aria-label="画布工具">
      <button type="button" className="work-command" aria-label="缩小画布" disabled={zoom <= 0.6} onClick={() => setZoom(value => Math.max(0.6, Math.round((value - 0.1) * 10) / 10))}>−</button>
      <span className="text-sm text-ink-secondary" aria-label="画布缩放比例">{Math.round(zoom * 100)}%</span>
      <button type="button" className="work-command" aria-label="放大画布" disabled={zoom >= 1.5} onClick={() => setZoom(value => Math.min(1.5, Math.round((value + 0.1) * 10) / 10))}>+</button>
      <button type="button" className="work-command" aria-label="重置画布缩放" onClick={() => setZoom(1)}>重置缩放</button>
      <button type="button" className="work-command" aria-label="自动排列步骤" disabled={!definition.nodes.length} onClick={onAutoLayout}>自动排列步骤</button>
    </div>
    <div className="max-h-[560px] overflow-auto" aria-label="画布滚动区域">
    <div className="relative" style={{ width: width * zoom, height: height * zoom }}>
    <div className="absolute left-0 top-0" style={{ width, height, transform: `scale(${zoom})`, transformOrigin: 'top left' }}>
      <svg className="pointer-events-none absolute inset-0" width={width} height={height} aria-label="步骤依赖连线" role="img">
        <defs><marker id="workflow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
        {definition.edges.map(edge => {
          const from = definition.nodes.find(n => n.id === edge.from), to = definition.nodes.find(n => n.id === edge.to);
          return from && to ? <path key={edge.from + ':' + edge.to + ':' + (edge.when || '')} d={`M ${from.x + 210} ${from.y + 50} C ${from.x + 250} ${from.y + 50}, ${to.x - 40} ${to.y + 50}, ${to.x} ${to.y + 50}`}
            fill="none" stroke="currentColor" strokeWidth="2" markerEnd="url(#workflow-arrow)"><title>{from.title} {edge.when ? `(${edge.when})` : ''} → {to.title}</title></path> : null;
        })}
      </svg>
      {definition.nodes.map((node, index) => <div key={node.id} className={`absolute w-[210px] rounded border bg-surface p-3 shadow-sm ${selected === node.id ? 'border-brand ring-1 ring-brand' : 'border-line'}`} style={{ left: node.x, top: node.y }}>
        <button className="block w-full touch-none cursor-move text-left text-xs text-ink-secondary" aria-label={`移动步骤 ${index + 1}`}
          onPointerDown={e => { if (e.button !== 0) return; onSelect(node.id); drag.current = { id: node.id, pointer: e.pointerId, x: node.x, y: node.y, startX: e.clientX, startY: e.clientY }; e.currentTarget.setPointerCapture(e.pointerId); }}
          onPointerMove={e => { const d = drag.current; if (d?.id === node.id && d.pointer === e.pointerId) onMove(node.id, clamp(d.x + (e.clientX - d.startX) / zoom), clamp(d.y + (e.clientY - d.startY) / zoom)); }}
          onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
          onKeyDown={e => { const delta: Record<string, [number, number]> = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }; if (delta[e.key]) { e.preventDefault(); onMove(node.id, clamp(node.x + delta[e.key][0]), clamp(node.y + delta[e.key][1])); } }}>步骤 {index + 1} · 拖动 / 方向键移动</button>
        <button className="mt-2 block w-full truncate text-left font-medium" aria-label={`编辑步骤 ${index + 1}`} onClick={() => onSelect(node.id)}>{node.title}</button>
        <p className="mt-1 text-xs text-ink-secondary">{NODE_LABELS[node.kind]}</p>
      </div>)}
    </div></div></div>
  </div>;
}
