import type { GenerationPreview as Preview } from '@/services/generationPreview';
import { PREVIEW_CHARACTERS } from '@/services/generationPreview';

export function GenerationPreview({ value, label }: { value: Preview; label: string }) {
  return <section className="mt-4 min-w-0 rounded border border-line p-3" aria-label={label}>
    <p className="text-sm text-ink-secondary">生成中 · 已接收 {value.characters} 个字符，尚未保存为成果。{value.characters > PREVIEW_CHARACTERS ? `预览仅显示前 ${PREVIEW_CHARACTERS} 个字符，最终结果以完整校验后保存的内容为准。` : ''}</p>
    <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-sm">{value.text}</pre>
  </section>;
}
