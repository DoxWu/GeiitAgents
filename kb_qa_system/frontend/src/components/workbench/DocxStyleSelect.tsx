import { DOCX_FONT_FAMILIES, DOCX_FONT_SIZES, DOCX_LINE_SPACINGS, DOCX_MARGINS, DOCX_PAPER_SIZES, DOCX_STYLE_OPTIONS, type DocxFormatOptions, type DocxStyle } from '@/officeTasks/docxStyles';

export function DocxStyleSelect({ value, onChange, format, onFormatChange, disabled = false }: { value: DocxStyle; onChange: (value: DocxStyle) => void; format: DocxFormatOptions; onFormatChange: (value: DocxFormatOptions) => void; disabled?: boolean }) {
  const patch = <K extends keyof DocxFormatOptions>(key: K, raw: string) => onFormatChange({ ...format, [key]: raw === '' ? undefined : Number.isNaN(Number(raw)) ? raw : Number(raw) });
  return <div className="grid min-w-48 gap-2">{<label className="work-label">Word 样式<select aria-label="Word 样式" className="work-input" value={value} disabled={disabled}
    onChange={event => onChange(event.target.value as DocxStyle)}>
    {DOCX_STYLE_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
  </select></label>}
    <details className="text-sm"><summary className="cursor-pointer select-none">页面与字体</summary><div className="mt-2 grid grid-cols-2 gap-2">
      <label className="work-label">纸张<select aria-label="Word 纸张" className="work-input" value={format.paperSize ?? ''} disabled={disabled} onChange={event => patch('paperSize', event.target.value)}><option value="">跟随样式</option>{DOCX_PAPER_SIZES.map(value => <option key={value}>{value}</option>)}</select></label>
      <label className="work-label">字体<select aria-label="Word 字体" className="work-input" value={format.fontFamily ?? ''} disabled={disabled} onChange={event => patch('fontFamily', event.target.value)}><option value="">跟随样式</option>{DOCX_FONT_FAMILIES.map(value => <option key={value}>{value}</option>)}</select></label>
      <label className="work-label">字号<select aria-label="Word 字号" className="work-input" value={format.fontSize ?? ''} disabled={disabled} onChange={event => patch('fontSize', event.target.value)}><option value="">跟随样式</option>{DOCX_FONT_SIZES.map(value => <option key={value} value={value}>{value} pt</option>)}</select></label>
      <label className="work-label">行距<select aria-label="Word 行距" className="work-input" value={format.lineSpacing ?? ''} disabled={disabled} onChange={event => patch('lineSpacing', event.target.value)}><option value="">跟随样式</option>{DOCX_LINE_SPACINGS.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <label className="work-label col-span-2">页边距<select aria-label="Word 页边距" className="work-input" value={format.marginInches ?? ''} disabled={disabled} onChange={event => patch('marginInches', event.target.value)}><option value="">跟随样式</option>{DOCX_MARGINS.map(value => <option key={value} value={value}>{value} 英寸</option>)}</select></label>
    </div></details>
  </div>;
}
