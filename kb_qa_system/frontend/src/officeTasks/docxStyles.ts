export const DOCX_STYLES = ['standard', 'business', 'meeting'] as const;
export type DocxStyle = typeof DOCX_STYLES[number];

export const DOCX_PAPER_SIZES = ['A4', 'Letter'] as const;
export const DOCX_FONT_FAMILIES = ['Microsoft YaHei', 'Aptos', 'Arial', 'Times New Roman'] as const;
export const DOCX_FONT_SIZES = [10, 11, 12, 14, 16] as const;
export const DOCX_LINE_SPACINGS = [1, 1.15, 1.5, 2] as const;
export const DOCX_MARGINS = [0.5, 0.75, 1, 1.25, 1.5] as const;

export interface DocxFormatOptions {
  paperSize?: typeof DOCX_PAPER_SIZES[number];
  fontFamily?: typeof DOCX_FONT_FAMILIES[number];
  fontSize?: typeof DOCX_FONT_SIZES[number];
  lineSpacing?: typeof DOCX_LINE_SPACINGS[number];
  marginInches?: typeof DOCX_MARGINS[number];
}

export const DEFAULT_DOCX_FORMAT: DocxFormatOptions = {};

export const DOCX_STYLE_OPTIONS: { id: DocxStyle; label: string }[] = [
  { id: 'standard', label: '经典 · Letter' },
  { id: 'business', label: '商务报告 · A4' },
  { id: 'meeting', label: '会议纪要 · A4' },
];

export function isDocxStyle(value: unknown): value is DocxStyle {
  return typeof value === 'string' && DOCX_STYLES.includes(value as DocxStyle);
}

export function validateDocxFormat(value: unknown): DocxFormatOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Word 页面与字体设置无效。');
  const source = value as Record<string, unknown>, allowed = ['paperSize', 'fontFamily', 'fontSize', 'lineSpacing', 'marginInches'];
  if (Object.keys(source).some(key => !allowed.includes(key))) throw new Error('Word 页面与字体设置包含未知选项。');
  const result: DocxFormatOptions = {};
  if (source.paperSize !== undefined) {
    if (!DOCX_PAPER_SIZES.includes(source.paperSize as typeof DOCX_PAPER_SIZES[number])) throw new Error('Word 纸张尺寸无效。');
    result.paperSize = source.paperSize as DocxFormatOptions['paperSize'];
  }
  if (source.fontFamily !== undefined) {
    if (!DOCX_FONT_FAMILIES.includes(source.fontFamily as typeof DOCX_FONT_FAMILIES[number])) throw new Error('Word 字体无效。');
    result.fontFamily = source.fontFamily as DocxFormatOptions['fontFamily'];
  }
  if (source.fontSize !== undefined) {
    if (!DOCX_FONT_SIZES.includes(source.fontSize as typeof DOCX_FONT_SIZES[number])) throw new Error('Word 字号无效。');
    result.fontSize = source.fontSize as DocxFormatOptions['fontSize'];
  }
  if (source.lineSpacing !== undefined) {
    if (!DOCX_LINE_SPACINGS.includes(source.lineSpacing as typeof DOCX_LINE_SPACINGS[number])) throw new Error('Word 行距无效。');
    result.lineSpacing = source.lineSpacing as DocxFormatOptions['lineSpacing'];
  }
  if (source.marginInches !== undefined) {
    if (!DOCX_MARGINS.includes(source.marginInches as typeof DOCX_MARGINS[number])) throw new Error('Word 页边距无效。');
    result.marginInches = source.marginInches as DocxFormatOptions['marginInches'];
  }
  return result;
}
