import { DOCX_STYLE_OPTIONS, type DocxStyle } from '@/officeTasks/docxStyles';

export function DocxStyleSelect({ value, onChange, disabled = false }: { value: DocxStyle; onChange: (value: DocxStyle) => void; disabled?: boolean }) {
  return <label className="work-label min-w-48">Word 样式<select aria-label="Word 样式" className="work-input" value={value} disabled={disabled}
    onChange={event => onChange(event.target.value as DocxStyle)}>
    {DOCX_STYLE_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
  </select></label>;
}
