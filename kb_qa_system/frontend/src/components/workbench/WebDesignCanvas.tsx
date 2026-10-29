import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { GripVertical, MoveDiagonal2 } from 'lucide-react';
import type { WorkImage } from '@/types/workbench';
import { moveWebComponent, resizeWebComponent, shapeRadius, type WebDesignComponent } from './webDesignerSchema';

interface Props {
  components: WebDesignComponent[];
  images: WorkImage[];
  selectedId: string;
  onSelect: (id: string) => void;
  onChange: Dispatch<SetStateAction<WebDesignComponent[]>>;
}

type Interaction = {
  component: WebDesignComponent;
  mode: 'move' | 'resize';
  startX: number;
  startY: number;
  canvasWidth: number;
  canvasHeight: number;
};

function ComponentContent({ component, images }: { component: WebDesignComponent; images: WorkImage[] }) {
  const [activeTab, setActiveTab] = useState(0);
  const lines = component.content.split('\n').map(value => value.trim()).filter(Boolean);
  const itemStyle = { backgroundColor: component.background, color: component.color };
  switch (component.kind) {
    case 'text':
      return <div className="grid content-center gap-2 overflow-hidden p-3" style={itemStyle}><h3 className="text-base font-semibold">{component.label}</h3><p className="whitespace-pre-wrap break-words text-xs leading-5">{component.content}</p></div>;
    case 'image': {
      const image = images[component.imageIndex ?? -1];
      return image
        ? <img className="h-full w-full object-cover" src={image.dataUrl} alt={component.description || image.name} />
        : <div className="flex h-full items-center justify-center border-2 border-dashed p-3 text-center text-xs" style={{ ...itemStyle, borderColor: component.color }}>图片素材预览</div>;
    }
    case 'table': {
      const rows = lines.map(line => line.split('|').map(cell => cell.trim())).slice(0, 4);
      return <div className="h-full overflow-auto p-2" style={itemStyle}><table className="w-full border-collapse text-left text-[10px]"><tbody>{rows.map((row, index) => <tr key={`${index}-${row[0]}`} className={index === 0 ? 'font-semibold' : ''}>{row.map((cell, cellIndex) => <td key={`${cellIndex}-${cell}`} className="border border-current px-1.5 py-1">{cell}</td>)}</tr>)}</tbody></table></div>;
    }
    case 'animation':
      return <div className="flex h-full items-center gap-3 overflow-hidden p-3" style={itemStyle}><span className="web-canvas-motion h-7 w-7 shrink-0 rounded-full" style={{ backgroundColor: component.color }} /><div className="min-w-0"><strong className="block truncate text-xs">{component.label}</strong><span className="block truncate text-[10px]">{component.content}</span></div></div>;
    case 'button':
      return <div className="flex h-full items-center justify-center p-2"><button type="button" className="h-full w-full truncate px-3 text-xs font-medium" style={itemStyle}>{component.content}</button></div>;
    case 'tabs': {
      const tabs = lines.slice(0, 5);
      return <div className="h-full overflow-hidden p-2" style={itemStyle}><div className="flex gap-1 border-b border-current/20">{tabs.map((tab, index) => <button type="button" key={tab} aria-pressed={activeTab === index} className="min-w-0 flex-1 truncate border-b-2 px-1 py-1 text-[10px]" style={{ borderColor: activeTab === index ? component.color : 'transparent' }} onClick={() => setActiveTab(index)}>{tab}</button>)}</div><p className="truncate pt-2 text-[10px]">{tabs[activeTab] || '页签内容'}</p></div>;
    }
    case 'form':
      return <form className="grid h-full content-center gap-1.5 overflow-hidden p-2" style={itemStyle} onSubmit={event => event.preventDefault()}>{lines.slice(0, 3).map((line, index) => index === lines.length - 1 && /提交|发送|预约/.test(line) ? <button type="button" key={line} className="truncate px-2 py-1 text-[10px]" style={{ backgroundColor: component.color, color: component.background }}>{line}</button> : <input key={`${index}-${line}`} aria-label={line} disabled placeholder={line} className="min-w-0 border border-current/20 bg-transparent px-2 py-1 text-[10px]" />)}</form>;
    case 'navbar':
      return <nav className="flex h-full items-center justify-between gap-2 overflow-hidden px-3" style={itemStyle}><strong className="truncate text-xs">{component.label}</strong><div className="flex min-w-0 gap-2">{lines.slice(0, 5).map(line => <span key={line} className="truncate text-[10px]">{line}</span>)}</div></nav>;
    case 'panel':
      return <aside className="grid h-full content-center gap-1 overflow-hidden p-3" style={itemStyle}><strong className="truncate text-xs">{component.label}</strong><p className="line-clamp-3 whitespace-pre-wrap break-words text-[10px] leading-4">{component.content}</p></aside>;
    case 'floating-button':
      return <div className="flex h-full items-center justify-center p-1"><button type="button" className="h-full w-full truncate px-2 text-[10px] font-medium shadow-sm" style={itemStyle}>{component.content}</button></div>;
    case 'link':
      return <div className="flex h-full items-center overflow-hidden px-3" style={itemStyle}><span className="truncate text-xs underline underline-offset-2">{component.content}</span></div>;
  }
}

export function WebDesignCanvas({ components, images, selectedId, onSelect, onChange }: Props) {
  const canvas = useRef<HTMLDivElement>(null);
  const [interaction, setInteraction] = useState<Interaction | null>(null);

  useEffect(() => {
    if (!interaction) return;
    const update = (event: PointerEvent) => {
      const dx = event.clientX - interaction.startX, dy = event.clientY - interaction.startY;
      const changed = interaction.mode === 'move'
        ? moveWebComponent(interaction.component, dx, dy, interaction.canvasWidth, interaction.canvasHeight)
        : resizeWebComponent(interaction.component, dx, dy, interaction.canvasWidth, interaction.canvasHeight);
      onChange(current => current.map(item => item.id === changed.id ? changed : item));
    };
    const finish = () => setInteraction(null);
    window.addEventListener('pointermove', update);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    return () => {
      window.removeEventListener('pointermove', update);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
  }, [interaction, onChange]);

  function start(event: React.PointerEvent, component: WebDesignComponent, mode: Interaction['mode']) {
    event.preventDefault();
    event.stopPropagation();
    const rect = canvas.current?.getBoundingClientRect();
    if (!rect) return;
    onSelect(component.id);
    setInteraction({ component, mode, startX: event.clientX, startY: event.clientY, canvasWidth: rect.width, canvasHeight: rect.height });
  }

  return <div className="web-design-canvas relative isolate h-[660px] w-full overflow-hidden border border-line" ref={canvas} role="region" aria-label="自由排版画布">
    {components.map(component => {
      const selected = selectedId === component.id;
      return <div key={component.id} data-component-id={component.id} onClick={() => onSelect(component.id)} className={`absolute overflow-hidden border ${component.shape === 'outline' ? 'border-dashed' : 'border-current/20'} ${selected ? 'z-20 outline outline-2 outline-offset-1 outline-brand' : 'z-10'}`}
        style={{ left: `${component.x}%`, top: `${component.y}%`, width: `${component.width}%`, height: `${component.height}%`, backgroundColor: component.background, color: component.color, borderRadius: shapeRadius(component.shape) }}>
        <button type="button" className="web-canvas-drag absolute left-1 top-1 z-30 flex h-6 max-w-[calc(100%-2rem)] items-center gap-1 border border-current/20 bg-surface/90 px-1 text-[9px] shadow-sm" aria-label={`拖动${component.label}`} title="拖动组件" onPointerDown={event => start(event, component, 'move')}>
          <GripVertical size={12} /><span className="truncate">{component.label}</span>
        </button>
        <div className="h-full w-full overflow-hidden pt-7"><ComponentContent component={component} images={images} /></div>
        {selected && <button type="button" className="web-canvas-resize absolute bottom-0 right-0 z-30 flex h-7 w-7 items-center justify-center border border-current/30 bg-surface" aria-label={`调整${component.label}大小`} title="调整大小" onPointerDown={event => start(event, component, 'resize')}><MoveDiagonal2 size={14} /></button>}
      </div>;
    })}
  </div>;
}
