import type { DocxResult } from './docx';
import type { DocxFormatOptions, DocxStyle } from './docxStyles';
export function exportDocx(content: string, title: string, signal: AbortSignal, style: DocxStyle = 'standard', format: DocxFormatOptions = {}): Promise<DocxResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('导出已取消。')); return; }
    const worker = new Worker(new URL('./docx.worker.ts', import.meta.url), { type: 'module' });
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); worker.terminate(); };
    const abort = () => { cleanup(); reject(new Error('导出已取消或超时。')); };
    const timer = setTimeout(abort, 30_000);
    signal.addEventListener('abort', abort, { once: true });
    worker.onerror = () => { cleanup(); reject(new Error('无法启动本地 DOCX 转换器。')); };
    worker.onmessage = (event: MessageEvent<DocxResult & { ok: boolean; error?: string }>) => {
      cleanup(); if (event.data.ok) resolve(event.data); else reject(new Error(event.data.error || 'DOCX 转换失败。'));
    };
    worker.postMessage({ content, title, style, format });
  });
}
