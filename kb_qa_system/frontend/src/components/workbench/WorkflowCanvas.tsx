import { useRef } from 'react';
import { NODE_LABELS, type WorkflowDefinition } from '@/workflows/definition';

export function WorkflowCanvas({ definition, selected, onSelect, onMove }: {
  definition: WorkflowDefinition; selected: string; onSelect: (id: string) => void; onMove: (id: string, x: number, y: number) => void;
}) {
  const drag = useRef<{ id: string; pointer: number; x: number; y: number; startX: number; startY: number } | null>(null);
  const width = Math.max(780, ...definition.nodes.map(n => n.x + 250)), height = Math.max(340, ...definition.nodes.map(n => n.y + 135));
  const clamp = (value: number) => Math.round(Math.max(0, Math.min(2000, value)));
  return <div className="max-w-full overflow-auto rounded border border-line bg-muted" aria-label="工作流画布">
    <div className="relative" style={{ width, height }}>
      <svg className="pointer-events-none absolute inset-0" width={width} height={height} aria-label="步骤依赖连线" role="img">
        <defs><marker id="workflow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
        {definition.edges.map(edge => {
          const from = definition.nodes.find(n => n.id === edge.from), to = definition.nodes.find(n => n.id === edge.to);
          return from && to ? <path key={edge.from + ':' + edge.to} d={`M ${from.x + 210} ${from.y + 50} C ${from.x + 250} ${from.y + 50}, ${to.x - 40} ${to.y + 50}, ${to.x} ${to.y + 50}`}
            fill="none" stroke="currentColor" strokeWidth="2" markerEnd="url(#workflow-arrow)"><title>{from.title} → {to.title}</title></path> : null;
        })}
      </svg>
      {definition.nodes.map((node, index) => <div key={node.id} className={`absolute w-[210px] rounded border bg-surface p-3 shadow-sm ${selected === node.id ? 'border-brand ring-1 ring-brand' : 'border-line'}`} style={{ left: node.x, top: node.y }}>
        <button className="block w-full touch-none cursor-move text-left text-xs text-ink-secondary" aria-label={`移动步骤 ${index + 1}`}
          onPointerDown={e => { if (e.button !== 0) return; onSelect(node.id); drag.current = { id: node.id, pointer: e.pointerId, x: node.x, y: node.y, startX: e.clientX, startY: e.clientY }; e.currentTarget.setPointerCapture(e.pointerId); }}
          onPointerMove={e => { const d = drag.current; if (d?.id === node.id && d.pointer === e.pointerId) onMove(node.id, clamp(d.x + e.clientX - d.startX), clamp(d.y + e.clientY - d.startY)); }}
          onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
          onKeyDown={e => { const delta: Record<string, [number, number]> = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }; if (delta[e.key]) { e.preventDefault(); onMove(node.id, clamp(node.x + delta[e.key][0]), clamp(node.y + delta[e.key][1])); } }}>步骤 {index + 1} · 拖动 / 方向键移动</button>
        <button className="mt-2 block w-full truncate text-left font-medium" aria-label={`编辑步骤 ${index + 1}`} onClick={() => onSelect(node.id)}>{node.title}</button>
        <p className="mt-1 text-xs text-ink-secondary">{NODE_LABELS[node.kind]}</p>
      </div>)}
    </div>
  </div>;
}
