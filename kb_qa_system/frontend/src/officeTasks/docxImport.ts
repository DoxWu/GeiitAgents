import type JSZip from 'jszip';

const MAX_ARCHIVE_BYTES = 2_000_000;
const MAX_ENTRY_COUNT = 256;
const MAX_UNCOMPRESSED_BYTES = 12_000_000;
const MAX_XML_BYTES = 8_000_000;
const MAX_TEXT_CHARS = 50_000;

interface StreamHelper {
  on(event: 'data', callback: (chunk: Uint8Array) => void): this;
  on(event: 'error', callback: (error: Error) => void): this;
  on(event: 'end', callback: () => void): this;
  pause(): this;
  resume(): this;
}
interface ZipEntry extends JSZip.JSZipObject {
  _data?: { compressedSize: number; uncompressedSize: number };
  internalStream(type: 'uint8array'): StreamHelper;
}

export interface ImportedDocxReference { markdown: string; warnings: string[] }
function fail(message: string): never { throw new Error(message); }

function readEntry(file: ZipEntry, budget: { used: number }): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const stream = file.internalStream('uint8array'), chunks: Uint8Array[] = [];
    let length = 0, settled = false;
    const stop = (error: Error) => { if (!settled) { settled = true; stream.pause(); reject(error); } };
    stream.on('data', chunk => {
      length += chunk.byteLength; budget.used += chunk.byteLength;
      if (length > MAX_XML_BYTES || budget.used > MAX_UNCOMPRESSED_BYTES) { stop(new Error('DOCX 解压内容超过安全大小限制。')); return; }
      chunks.push(chunk);
    }).on('error', error => stop(new Error(`DOCX 条目无法解压：${error.message}`))).on('end', () => {
      if (settled) return;
      settled = true;
      const output = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
      resolve(output);
    });
    stream.resume();
  });
}

function parseXml(source: string): XMLDocument {
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(source)) fail('DOCX XML 不支持文档类型声明或实体。');
  const doc = new DOMParser().parseFromString(source, 'application/xml');
  if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'document') fail('DOCX 主文档结构无效或 XML 已损坏。');
  return doc;
}
function children(node: Element, localName: string): Element[] { return Array.from(node.children).filter(child => child.localName === localName); }
function valueAttribute(node: Element | undefined): string {
  return node ? Array.from(node.attributes).find(attribute => attribute.localName === 'val')?.value ?? '' : '';
}

function paragraphText(node: Element): string {
  const chunks: string[] = [];
  const walker = node.ownerDocument!.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) {
    const element = walker.currentNode as Element;
    if (element.localName === 't') chunks.push(element.textContent ?? '');
    else if (element.localName === 'tab') chunks.push('\t');
    else if (element.localName === 'br' || element.localName === 'cr') chunks.push('\n');
  }
  return Array.from(chunks.join('')).filter(char => {
    const code = char.charCodeAt(0);
    return !(code < 32 && ![9, 10, 13].includes(code)) && code !== 127;
  }).join('').trim();
}

function markdownTable(table: Element): string {
  const rows = children(table, 'tr').map(row => children(row, 'tc').map(cell =>
    children(cell, 'p').map(paragraphText).filter(Boolean).join('<br>').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')));
  if (!rows.length) return '';
  const width = Math.max(...rows.map(row => row.length));
  if (!width) return '';
  const normalized = rows.map(row => Array.from({ length: width }, (_, index) => row[index] ?? ''));
  const separator = Array.from({ length: width }, () => '---');
  return [normalized[0], separator, ...normalized.slice(1)].map(row => `| ${row.join(' | ')} |`).join('\n');
}

function renderBlock(block: Element): string {
  if (block.localName === 'p') {
    const text = paragraphText(block);
    if (!text) return '';
    const pPr = children(block, 'pPr')[0], style = valueAttribute(pPr ? children(pPr, 'pStyle')[0] : undefined);
    const heading = /^Heading([1-6])$/i.exec(style);
    if (heading) return `${'#'.repeat(Number(heading[1]))} ${text}`;
    const numPr = pPr ? children(pPr, 'numPr')[0] : undefined, numbering = numPr ? children(numPr, 'numFmt')[0] : undefined;
    return numbering && ['decimal', 'decimalZero', 'lowerLetter', 'upperLetter', 'lowerRoman', 'upperRoman'].includes(valueAttribute(numbering)) ? `1. ${text}` : numPr ? `- ${text}` : text;
  }
  if (block.localName === 'tbl') return markdownTable(block);
  return '';
}

export async function importDocxReference(data: ArrayBuffer | Uint8Array): Promise<ImportedDocxReference> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (!bytes.length || bytes.byteLength > MAX_ARCHIVE_BYTES) fail('请选择不超过 2 MB 的非空 DOCX 文件。');
  const { default: JSZip } = await import('jszip');
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes, { checkCRC32: false, createFolders: false }); }
  catch { return fail('无法读取 DOCX 压缩包；请确认文件未加密且格式有效。'); }
  const entries = Object.values(zip.files) as ZipEntry[];
  if (!entries.length || entries.length > MAX_ENTRY_COUNT) fail('DOCX 条目数量超过限制。');
  let declaredSize = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    if (entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name) fail('DOCX 包含不安全路径。');
    if (entry.name.startsWith('/') || entry.name.includes('\\') || entry.name.split('/').some(segment => segment === '..' || segment === '.')) fail('DOCX 包含不安全路径。');
    const size = entry._data?.uncompressedSize, compressed = entry._data?.compressedSize;
    if (!Number.isSafeInteger(size) || !Number.isSafeInteger(compressed) || size! < 0 || compressed! < 0) fail('DOCX 压缩包目录无效。');
    declaredSize += size!;
    if (declaredSize > MAX_UNCOMPRESSED_BYTES || size! > MAX_XML_BYTES || size! > Math.max(100_000, compressed! * 1000)) fail('DOCX 解压内容超过安全大小限制。');
  }
  const documentEntry = zip.file('word/document.xml') as ZipEntry | null;
  if (!documentEntry) fail('DOCX 缺少主文档内容。');
  const raw = await readEntry(documentEntry, { used: 0 });
  let xml: string;
  try { xml = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
  catch { return fail('DOCX 主文档不是有效 UTF-8。'); }
  const doc = parseXml(xml), body = Array.from(doc.getElementsByTagName('*')).find(element => element.localName === 'body');
  if (!body) fail('DOCX 主文档没有正文。');
  const markdown = Array.from(body.children).map(renderBlock).filter(Boolean).join('\n\n').trim();
  if (!markdown) fail('DOCX 正文中没有可导入的文字或表格。');
  if (markdown.length > MAX_TEXT_CHARS) fail('DOCX 提取文本超过 50000 个字符限制。');
  const warnings: string[] = [];
  if (body.querySelector('drawing, pict, object, txbxContent, sym')) warnings.push('正文含图片、文本框、嵌入对象或特殊符号；这些内容未提取。');
  if (Object.keys(zip.files).some(name => /^word\/(header|footer|footnotes|endnotes|comments)/i.test(name))) warnings.push('页眉、页脚、脚注、尾注或批注未导入。');
  if (markdown.includes('|') && body.querySelector('vMerge, hMerge, gridSpan')) warnings.push('表格包含合并单元格；Markdown 表格无法完整保留原布局。');
  if (Array.from(body.querySelectorAll('*')).some(cell => cell.localName === 'tc' && children(cell, 'tbl').length)) warnings.push('正文含嵌套表格；嵌套层级未完整保留。');
  return { markdown, warnings };
}
