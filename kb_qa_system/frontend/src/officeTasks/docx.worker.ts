import { markdownToDocx } from './docx';
import type { DocxFormatOptions, DocxStyle } from './docxStyles';
self.onmessage = async (event: MessageEvent<{ content: string; title: string; style?: DocxStyle; format?: DocxFormatOptions }>) => {
  try {
    const result = await markdownToDocx(event.data.content, event.data.title, event.data.style, event.data.format);
    self.postMessage({ ok: true, ...result }, { transfer: [result.bytes] });
  } catch (error) { self.postMessage({ ok: false, error: error instanceof Error ? error.message : 'DOCX 转换失败。' }); }
};
