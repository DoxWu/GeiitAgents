import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

const MAX_FILE_BYTES = 10_000_000;
const MAX_PAGES = 100;
const MAX_TEXT_CHARS = 50_000;

export interface ImportedPdfReference { markdown: string; warnings: string[] }
function fail(message: string): never { throw new Error(message); }

export async function importPdfReference(data: ArrayBuffer | Uint8Array): Promise<ImportedPdfReference> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (!bytes.length || bytes.byteLength > MAX_FILE_BYTES) fail('请选择不超过 10 MB 的非空 PDF 文件。');
  const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist');
  GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const loadingTask = getDocument({ data: bytes.slice(), isEvalSupported: false, useSystemFonts: false, stopAtErrors: true });
  try {
    const document = await loadingTask.promise;
    if (document.numPages < 1 || document.numPages > MAX_PAGES) fail('PDF 页数须为 1–100 页。');
    const pages: string[] = [];
    const emptyPages: number[] = [];
    let length = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent({ includeMarkedContent: false });
      const text = content.items.flatMap(item => 'str' in item ? [item.str] : []).join(' ').replace(/[\t\f\v ]+/g, ' ').replace(/ *\n */g, '\n').trim();
      if (!text) emptyPages.push(pageNumber);
      const section = `## 第 ${pageNumber} 页${text ? `\n\n${text}` : '\n\n[此页未提取到文本]'}`;
      length += section.length + 2;
      if (length > MAX_TEXT_CHARS) fail('PDF 提取文本超过 50000 个字符限制。');
      pages.push(section);
      page.cleanup();
    }
    if (emptyPages.length === document.numPages) fail('PDF 中没有可导入的文字，可能是扫描件；当前不提供 OCR。');
    const warnings = ['PDF 仅提取可选中的文字；页面版式、图片、表单和批注不会保留。'];
    if (emptyPages.length) warnings.push(`第 ${emptyPages.slice(0, 10).join('、')} 页未提取到文本，可能含扫描图片；当前不提供 OCR。`);
    return { markdown: pages.join('\n\n'), warnings };
  } catch (error) {
    if (error instanceof Error && /PasswordException|password/i.test(`${error.name} ${error.message}`)) fail('PDF 受密码保护，无法导入。');
    if (error instanceof Error && /须为 1–100 页|超过 50000 个字符|没有可导入的文字|超过 10 MB/.test(error.message)) throw error;
    fail('无法读取 PDF；请确认文件未损坏且未加密。');
  } finally {
    await loadingTask.destroy();
  }
}
