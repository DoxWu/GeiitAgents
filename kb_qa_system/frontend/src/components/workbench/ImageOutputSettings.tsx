import { DEFAULT_ANIMATION, type ImageStudioDraft } from '@/officeTasks/composition';
import type { ImageOutputOptions } from '@/services/imageGeneration';
import { Hint } from './Hint';
import { useEffect, useState } from 'react';

function AnimationNumber({ label, value, min, max, step, onCommit }: { label: string; value: number; min: number; max: number; step: number; onCommit: (value: number) => void }) {
  const [text, setText] = useState(String(value)), [error, setError] = useState('');
  useEffect(() => { setText(String(value)); setError(''); }, [value]);
  return <label className="work-label">{label}<input aria-label={label} className="work-input" type="number" min={min} max={max} step={step} value={text} onChange={event => { setText(event.target.value); setError(''); }} onBlur={() => {
    const number = Number(text);
    if (text.trim() && Number.isInteger(number) && number >= min && number <= max) onCommit(number);
    else { setText(String(value)); setError(`请输入${min}–${max}之间的整数，已恢复之前的值。`); }
  }} />{error && <span className="text-xs text-danger" role="alert">{error}</span>}</label>;
}

export function ImageOutputSettings({ draft, onChange }: { draft: ImageStudioDraft; onChange: (patch: Partial<ImageStudioDraft>) => void }) {
  const output = draft.output ?? { format: 'png' }, animation = draft.animation ?? DEFAULT_ANIMATION;
  const patchOutput = (patch: Partial<ImageOutputOptions>) => onChange({ output: { ...output, ...patch } });
  return <div className="grid min-w-0 gap-3 border border-line p-3">
    <label className="work-label">生成格式<select aria-label="生成格式" className="work-input" value={output.format} onChange={event => onChange({ output: event.target.value === 'gif' ? { format: 'gif', frameCount: 9, frameDurationMs: 200, autoSize: true } : { format: event.target.value as 'png' | 'svg' } })}>
      <option value="png">普通图片（PNG / JPEG / WebP）</option><option value="svg">SVG 静态矢量图</option><option value="gif">GIF 动画</option>
    </select></label>
    {output.format !== 'png' && <Hint label="SVG与GIF兼容性">需要 gpt-image-2.6-sunburst、gpt-image-2.6-flare 或支持相同参数的兼容模型。两种格式仅走文字生成接口；参考图会留在当前任务中，移除后才能生成。SVG预览使用图片隔离，下载保留矢量内容。GIF尺寸和帧数共同占用供应商像素预算。</Hint>}
    {output.format === 'gif' && <>
      <label className="work-label">动画模板<select aria-label="动画模板" className="work-input" value="" onChange={event => { if (event.target.value) onChange({ animation: { ...animation, action: event.target.value } }); }}>
        <option value="">选择模板填入动作（可继续编辑）</option><option value={DEFAULT_ANIMATION.action}>呼吸与漂浮</option><option value="主体围绕垂直轴平滑旋转一周，回到起始角度">旋转展示</option><option value="主体向右缓慢移动，再向左返回起点">往返移动</option><option value="光点沿主体轮廓逐步亮起，亮度平滑增强再恢复">光效循环</option>
      </select></label>
      <label className="work-label">动画动作<textarea className="work-input min-h-20 resize-y" maxLength={500} value={animation.action} onChange={event => onChange({ animation: { ...animation, action: event.target.value } })} /></label>
      <label className="work-label">方向、速度与镜头<input className="work-input" maxLength={300} value={animation.motion} onChange={event => onChange({ animation: { ...animation, motion: event.target.value } })} /></label>
      <label className="work-label">循环方式<select aria-label="循环方式" className="work-input" value={animation.loop} onChange={event => onChange({ animation: { ...animation, loop: event.target.value as typeof animation.loop } })}><option value="seamless">无缝循环</option><option value="pingpong">往返循环</option><option value="once">单次动作叙事</option></select></label>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <AnimationNumber label="动画帧数" min={2} max={64} step={1} value={output.frameCount ?? 9} onCommit={frameCount => patchOutput({ frameCount })} />
        <AnimationNumber label="每帧毫秒" min={20} max={2000} step={10} value={output.frameDurationMs ?? 200} onCommit={frameDurationMs => patchOutput({ frameDurationMs })} />
      </div>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={output.autoSize ?? false} onChange={event => patchOutput({ autoSize: event.target.checked })} />自动选择帧尺寸（推荐，减少像素预算超限）</label>
      <p className="text-xs text-ink-secondary">约 {((output.frameCount ?? 9) * (output.frameDurationMs ?? 200) / 1000).toFixed(2)} 秒；每帧时长由接口按10毫秒舍入。主体、场景和风格在图片提示词中描述，实际提示词仍可完整编辑。</p>
    </>}
  </div>;
}
