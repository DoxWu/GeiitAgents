import { useEffect, useState } from 'react';
import { IMAGE_SIZE_PRESETS, imageSizeValue } from '@/services/imageGeneration';
import type { ImageCanvas } from '@/officeTasks/composition';

export function ImageCanvasSettings({ value, onChange }: { value: ImageCanvas; onChange: (value: ImageCanvas) => void }) {
  const [width, setWidth] = useState(String(value.width)), [height, setHeight] = useState(String(value.height)), [error, setError] = useState('');
  useEffect(() => { setWidth(String(value.width)); setHeight(String(value.height)); setError(''); }, [value.width, value.height]);
  return <fieldset className="grid min-w-0 content-start gap-3 border border-line p-3">
    <legend className="px-1 text-sm font-medium">画布与输出图片</legend>
    <label className="work-label">图片比例<select aria-label="图片比例" className="work-input" value={IMAGE_SIZE_PRESETS.some(p => p.width === value.width && p.height === value.height) ? imageSizeValue(value) : ''} onChange={event => {
      const preset = IMAGE_SIZE_PRESETS.find(p => imageSizeValue(p) === event.target.value);
      if (preset) onChange({ ...value, width: preset.width, height: preset.height });
    }}><option value="">自定义尺寸</option>{IMAGE_SIZE_PRESETS.map(p => <option key={imageSizeValue(p)} value={imageSizeValue(p)}>{p.label} · {p.width} × {p.height}</option>)}</select></label>
    <div className="grid min-w-0 grid-cols-2 gap-3">
      <label className="work-label">图片宽度（像素）<input className="work-input" type="number" min={512} max={4096} step={16} value={width} onChange={event => setWidth(event.target.value)} /></label>
      <label className="work-label">图片高度（像素）<input className="work-input" type="number" min={512} max={4096} step={16} value={height} onChange={event => setHeight(event.target.value)} /></label>
    </div>
    <button type="button" className="work-command justify-self-start" onClick={() => {
      try { const next = { ...value, width: Number(width), height: Number(height) }; imageSizeValue(next); onChange(next); setError(''); }
      catch (error) { setError(error instanceof Error ? error.message : '图片尺寸无效。'); }
    }}>应用尺寸</button>
    <label className="work-label">画布背景颜色<input type="color" className="h-9 w-full bg-transparent" value={value.background} onChange={event => onChange({ ...value, background: event.target.value })} /></label>
    <p className="text-xs text-ink-secondary">当前 {value.width} × {value.height} 像素。修改宽高后点击“应用尺寸”；区域百分比位置保留。该尺寸会同时用于构图预览、构图截图和生图请求，模型须支持所选尺寸。</p>
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
  </fieldset>;
}
