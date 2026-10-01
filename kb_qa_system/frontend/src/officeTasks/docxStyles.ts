export const DOCX_STYLES = ['standard', 'business', 'meeting'] as const;
export type DocxStyle = typeof DOCX_STYLES[number];

export const DOCX_STYLE_OPTIONS: { id: DocxStyle; label: string }[] = [
  { id: 'standard', label: '经典 · Letter' },
  { id: 'business', label: '商务报告 · A4' },
  { id: 'meeting', label: '会议纪要 · A4' },
];

export function isDocxStyle(value: unknown): value is DocxStyle {
  return typeof value === 'string' && DOCX_STYLES.includes(value as DocxStyle);
}
