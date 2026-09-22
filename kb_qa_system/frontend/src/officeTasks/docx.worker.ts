import { markdownToDocx } from './docx';
self.onmessage = async (event: MessageEvent<{ content: string; title: string }>) => {
  try {
    const result = await markdownToDocx(event.data.content, event.data.title);
    self.postMessage({ ok: true, ...result }, { transfer: [result.bytes] });
  } catch (error) { self.postMessage({ ok: false, error: error instanceof Error ? error.message : 'DOCX 转换失败。' }); }
};
