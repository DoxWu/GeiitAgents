import { markdownToDocx } from './docx';
import type { DocxStyle } from './docxStyles';
self.onmessage = async (event: MessageEvent<{ content: string; title: string; style?: DocxStyle }>) => {
  try {
    const result = await markdownToDocx(event.data.content, event.data.title, event.data.style);
    self.postMessage({ ok: true, ...result }, { transfer: [result.bytes] });
  } catch (error) { self.postMessage({ ok: false, error: error instanceof Error ? error.message : 'DOCX 转换失败。' }); }
};
