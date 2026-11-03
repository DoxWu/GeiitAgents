import { useRef, useState } from 'react';
import { Hint } from './Hint';
import { newCompositionShape, type CompositionShape } from '@/officeTasks/composition';
import type { WorkImage } from '@/types/workbench';
const bound = (v: number, min: number, max: number) => Math.max(min, Math.min(max,v));
export function CompositionCanvas({ shapes, onChange, images = [], background = '#f4f3ef', aspectRatio = 16 / 9 }: { shapes: CompositionShape[]; onChange: (shapes: CompositionShape[]) => void; images?: WorkImage[]; background?: string; aspectRatio?: number }) {
  const [selected, setSelected] = useState(''); const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<{id: string; action: 'move'|'resize'|'rotate'; x:number;y:number; shape:CompositionShape; rect:DOMRect; angle:number} | null>(null);
  const shape = shapes.find(s=>s.id===selected) ?? shapes[0];
  function patch(values:Partial<CompositionShape>) {if(shape)onChange(shapes.map(s=>s.id===shape.id?{...s,...values}:s));}
  function start(e:React.PointerEvent, s:CompositionShape, action:'move'|'resize'|'rotate') {
    if(e.button!==0)return; e.stopPropagation();e.preventDefault();setSelected(s.id);const rect=canvas.current!.getBoundingClientRect();
    const cx=rect.left+(s.x+s.w/2)*rect.width/100,cy=rect.top+(s.y+s.h/2)*rect.height/100;
    drag.current={id:s.id,action,x:e.clientX,y:e.clientY,shape:{...s},rect,angle:Math.atan2(e.clientY-cy,e.clientX-cx)*180/Math.PI};e.currentTarget.setPointerCapture(e.pointerId);
  }
  function move(e:React.PointerEvent) {const d=drag.current;if(!d)return;const s=d.shape,dx=(e.clientX-d.x)*100/d.rect.width,dy=(e.clientY-d.y)*100/d.rect.height;let p:Partial<CompositionShape>;
    if(d.action==='move')p={x:bound(s.x+dx,0,100-s.w),y:bound(s.y+dy,0,100-s.h)};
    else if(d.action==='resize'){
      const a=s.rotation*Math.PI/180,px=e.clientX-d.x,py=e.clientY-d.y;
      const w=bound(s.w+(px*Math.cos(a)+py*Math.sin(a))*100/d.rect.width,3,100),h=bound(s.h+(-px*Math.sin(a)+py*Math.cos(a))*100/d.rect.height,3,100);
      const dw=(w-s.w)*d.rect.width/100,dh=(h-s.h)*d.rect.height/100;
      p={w,h,x:bound(s.x+(dw*Math.cos(a)-dh*Math.sin(a)-dw)*50/d.rect.width,0,100-w),y:bound(s.y+(dw*Math.sin(a)+dh*Math.cos(a)-dh)*50/d.rect.height,0,100-h)};
    }
    else {const cx=d.rect.left+(s.x+s.w/2)*d.rect.width/100,cy=d.rect.top+(s.y+s.h/2)*d.rect.height/100;let angle=s.rotation+Math.atan2(e.clientY-cy,e.clientX-cx)*180/Math.PI-d.angle;angle=((angle+540)%360)-180;if(e.shiftKey)angle=Math.round(angle/15)*15;p={rotation:angle};}
    onChange(shapes.map(item=>item.id===d.id?{...item,...p}:item));
  }
  return <div className="grid min-w-0 max-w-full content-start gap-3 self-start" aria-label="构图编辑器"><div className="flex flex-wrap gap-2"><button type="button" className="work-command" disabled={shapes.length>=24} onClick={()=>{const next=newCompositionShape(shapes.length);onChange([...shapes,next]);setSelected(next.id);}}>添加区域</button><button type="button" className="work-command" disabled={!shape || shapes.length>=24} onClick={()=>{const next={...shape,id:crypto.randomUUID(),layer:Math.min(999,Math.max(...shapes.map(s=>s.layer))+1)};onChange([...shapes,next]);setSelected(next.id);}}>复制区域</button><button type="button" className="work-command" disabled={!shape} onClick={()=>onChange(shapes.filter(s=>s.id!==shape.id))}>删除区域</button></div>
    <div className="relative isolate w-full min-w-0 overflow-hidden touch-none border border-line self-start" aria-label="构图画布" ref={canvas} style={{backgroundColor:background,aspectRatio}} onPointerMove={move} onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}>
      {[...shapes].sort((a,b)=>a.layer-b.layer).map(s=><div key={s.id} data-shape-id={s.id} role="button" tabIndex={0} aria-label={`区域 ${s.text || s.description || s.kind}`} aria-pressed={shape?.id===s.id} className="absolute flex cursor-move items-center justify-center overflow-visible text-xs outline-offset-2" style={{left:`${s.x}%`,top:`${s.y}%`,width:`${s.w}%`,height:`${s.h}%`,transform:`rotate(${s.rotation}deg)`,zIndex:s.layer,outline:shape?.id===s.id?'2px solid var(--color-brand, #c66b39)':undefined}} onClick={()=>setSelected(s.id)} onPointerDown={e=>start(e,s,'move')} onKeyDown={e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();setSelected(s.id);onChange(shapes.map(i=>i.id===s.id?{...i,x:bound(i.x+(e.key==='ArrowRight'?1:e.key==='ArrowLeft'?-1:0),0,100-i.w),y:bound(i.y+(e.key==='ArrowDown'?1:e.key==='ArrowUp'?-1:0),0,100-i.h)}:i));}}>
        <div className="pointer-events-none absolute inset-0 overflow-hidden" style={{backgroundColor:s.kind==='text'?'transparent':s.color,borderRadius:s.kind==='ellipse'?'50%':0,clipPath:s.kind==='triangle'?'polygon(50% 0,100% 100%,0 100%)':undefined}}>{s.kind==='image'&&images[s.imageIndex??-1]&&<img alt="" className="h-full w-full object-contain" src={images[s.imageIndex!].dataUrl}/>}</div><span className="pointer-events-none relative max-h-full max-w-full overflow-hidden whitespace-pre-wrap p-2" style={{color:s.kind==='text'?s.color:'#202020'}}>{s.text||s.description||s.kind}</span>
        {shape?.id===s.id&&<><button type="button" aria-label="旋转区域" className="absolute -top-6 left-1/2 h-4 w-4 rounded-full border-2 border-white bg-brand" onPointerDown={e=>start(e,s,'rotate')} /><button type="button" aria-label="调整区域大小" className="absolute -bottom-1 -right-1 h-3 w-3 border border-white bg-brand" onPointerDown={e=>start(e,s,'resize')} /></>}
      </div>)}
    </div>
    <div><Hint label="构图操作">拖动区域或右下角改变大小，顶部圆点旋转（Shift 吸附15°）；层号越大越靠前。选中不改变层级，也可从下拉框选取被遮挡区域。</Hint></div>
    <select aria-label="选择区域" className="work-input" value={shape?.id??''} onChange={e=>setSelected(e.target.value)}><option value="">选择区域</option>{shapes.map((s,i)=><option key={s.id} value={s.id}>区域{i+1} · {s.kind} · 层{s.layer}</option>)}</select>
    {shape&&<div className="grid min-w-0 gap-3 sm:grid-cols-2"><label className="work-label">区域类型<select className="work-input" value={shape.kind} onChange={e=>patch({kind:e.target.value as CompositionShape['kind']})}><option value="rectangle">矩形</option><option value="ellipse">椭圆</option><option value="triangle">三角形</option><option value="text">文字</option><option value="image">图片</option></select></label><label className="work-label">区域颜色<input type="color" className="h-9 w-full bg-transparent" value={shape.color} onChange={e=>patch({color:e.target.value})}/></label>
      {(['x','y','w','h','rotation','layer'] as const).map(k=><label className="work-label" key={k}>{({x:'水平位置 %',y:'垂直位置 %',w:'宽度 %',h:'高度 %',rotation:'旋转角度',layer:'层号'})[k]}<input className="work-input" type="number" aria-label={k==='rotation'?'旋转角度':k==='layer'?'层号':k} value={Math.round(shape[k]*100)/100} min={k==='rotation'?-360:k==='w'||k==='h'?3:0} max={k==='rotation'?360:k==='layer'?999:100} onChange={e=>{const v=Number(e.target.value);if(!Number.isFinite(v))return;patch(k==='x'?{x:bound(v,0,100-shape.w)}:k==='y'?{y:bound(v,0,100-shape.h)}:k==='w'?{w:bound(v,3,100-shape.x)}:k==='h'?{h:bound(v,3,100-shape.y)}:k==='layer'?{layer:Math.round(bound(v,0,999))}:{rotation:bound(v,-360,360)});}}/></label>)}
      <div className="flex flex-wrap gap-2 sm:col-span-2"><button type="button" className="work-command" onClick={()=>patch({layer:Math.min(999,shape.layer+1)})}>上移一层</button><button type="button" className="work-command" onClick={()=>patch({layer:Math.max(0,shape.layer-1)})}>下移一层</button></div>
      {shape.kind==='image'&&<label className="work-label">图片素材<select className="work-input" value={shape.imageIndex??''} onChange={e=>patch({imageIndex:e.target.value===''?undefined:Number(e.target.value)})}><option value="">未绑定</option>{images.map((i,n)=><option key={n} value={n}>{i.name}</option>)}</select></label>}
      <label className="work-label sm:col-span-2">确定展示的文字<textarea className="work-input" maxLength={12000} value={shape.text} onChange={e=>patch({text:e.target.value})}/></label><label className="work-label sm:col-span-2">区域描述 / 内容主题<textarea className="work-input" maxLength={2000} value={shape.description} onChange={e=>patch({description:e.target.value})} placeholder="说明区域用途、期望画面或需要模型撰写的主题"/></label>
    </div>}
  </div>;
}
