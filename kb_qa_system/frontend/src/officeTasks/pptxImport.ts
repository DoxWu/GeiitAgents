import type JSZip from 'jszip';

const MAX_ARCHIVE_BYTES = 5_000_000;
const MAX_ENTRY_COUNT = 512;
const MAX_UNCOMPRESSED_BYTES = 25_000_000;
const MAX_XML_BYTES = 8_000_000;
const MAX_SLIDES = 120;
const MAX_TEXT_CHARS = 50_000;
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

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

export interface ImportedPptxReference { markdown: string; warnings: string[] }
function fail(message: string): never { throw new Error(message); }

function validateArchive(zip: JSZip) {
  const entries = Object.values(zip.files) as ZipEntry[];
  if (!entries.length || entries.length > MAX_ENTRY_COUNT) fail('PPTX 条目数量超过限制。');
  let total = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    if (entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name) fail('PPTX 包含不安全路径。');
    if (entry.name.startsWith('/') || entry.name.includes('\\') || entry.name.split('/').some(segment => !segment || segment === '..' || segment === '.')) fail('PPTX 包含不安全路径。');
    const size = entry._data?.uncompressedSize, compressed = entry._data?.compressedSize;
    if (!Number.isSafeInteger(size) || !Number.isSafeInteger(compressed) || size! < 0 || compressed! < 0) fail('PPTX 压缩包目录无效。');
    total += size!;
    if (total > MAX_UNCOMPRESSED_BYTES || size! > MAX_XML_BYTES || size! > Math.max(100_000, compressed! * 1000)) fail('PPTX 解压内容超过安全大小限制。');
  }
}

function readEntry(file: ZipEntry, budget: { used: number }): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const stream = file.internalStream('uint8array'), chunks: Uint8Array[] = [];
    let length = 0, settled = false;
    const stop = (error: Error) => { if (!settled) { settled = true; stream.pause(); reject(error); } };
    stream.on('data', chunk => {
      length += chunk.byteLength; budget.used += chunk.byteLength;
      if (length > MAX_XML_BYTES || budget.used > MAX_UNCOMPRESSED_BYTES) { stop(new Error('PPTX 解压内容超过安全大小限制。')); return; }
      chunks.push(chunk);
    }).on('error', error => stop(new Error(`PPTX 条目无法解压：${error.message}`))).on('end', () => {
      if (settled) return;
      settled = true;
      const output = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
      resolve(output);
    });
    stream.resume();
  });
}

async function readXml(zip: JSZip, path: string, budget: { used: number }): Promise<XMLDocument> {
  const file = zip.file(path) as ZipEntry | null;
  if (!file) fail(`PPTX 缺少必要内容：${path}`);
  let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(await readEntry(file, budget)); }
  catch (error) {
    if (error instanceof Error && error.message.includes('PPTX ')) throw error;
    return fail(`PPTX XML 不是有效 UTF-8：${path}`);
  }
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(source)) fail('PPTX XML 不支持文档类型声明或实体。');
  const doc = new DOMParser().parseFromString(source, 'application/xml');
  if (doc.querySelector('parsererror')) fail(`PPTX XML 已损坏：${path}`);
  return doc;
}

function children(node: Element, localName: string): Element[] { return Array.from(node.children).filter(child => child.localName === localName); }
function descendants(node: ParentNode, localName: string): Element[] { return Array.from(node.querySelectorAll('*')).filter(element => element.localName === localName); }
function attrByLocalName(node: Element, name: string): string { return Array.from(node.attributes).find(attribute => attribute.localName === name)?.value ?? ''; }

function slideTarget(value: string): string {
  if (!value || value.includes('\\') || /[?#%:]/.test(value)) fail('PPTX 幻灯片关系路径无效。');
  const path = value.startsWith('/') ? value.slice(1) : `ppt/${value}`;
  const parts = path.split('/');
  if (parts.length !== 3 || parts[0] !== 'ppt' || parts[1] !== 'slides' || !/^slide[^/]+\.xml$/i.test(parts[2])) fail('PPTX 幻灯片关系路径越出幻灯片目录。');
  return path;
}

function textOfParagraph(paragraph: Element): string {
  const parts: string[] = [], walker = paragraph.ownerDocument!.createTreeWalker(paragraph, NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) {
    const element = walker.currentNode as Element;
    if (element.localName === 't') parts.push(element.textContent ?? '');
    else if (element.localName === 'br') parts.push('\n');
  }
  const text = Array.from(parts.join('')).filter(char => {
    const code = char.charCodeAt(0);
    return !(code < 32 && ![9, 10, 13].includes(code)) && code !== 127;
  }).join('').trim();
  if (!text) return '';
  const properties = children(paragraph, 'pPr')[0];
  if (properties && children(properties, 'buChar').length) return `- ${text}`;
  if (properties && children(properties, 'buAutoNum').length) return `1. ${text}`;
  return text;
}

function paragraphs(container: Element): string[] {
  return children(container, 'p').map(textOfParagraph).filter(Boolean);
}

function markdownTable(table: Element): string {
  const rows = descendants(table, 'tr').filter(row => row.parentElement?.localName === 'tbl').map(row =>
    children(row, 'tc').map(cell => paragraphs(cell).join('<br>').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')));
  if (!rows.length) return '';
  const width = Math.max(...rows.map(row => row.length));
  if (!width) return '';
  const normalized = rows.map(row => Array.from({ length: width }, (_, index) => row[index] ?? ''));
  return [normalized[0], Array.from({ length: width }, () => '---'), ...normalized.slice(1)].map(row => `| ${row.join(' | ')} |`).join('\n');
}

function renderSlide(slide: XMLDocument, index: number): { markdown: string; hasPicture: boolean; hasChart: boolean } {
  if (slide.documentElement.localName !== 'sld') fail('PPTX 幻灯片 XML 根节点无效。');
  const tree = descendants(slide, 'spTree')[0];
  if (!tree) return { markdown: `## 幻灯片 ${index + 1}`, hasPicture: false, hasChart: false };
  const blocks: string[] = [`## 幻灯片 ${index + 1}`];
  let hasTitle = false, hasPicture = false, hasChart = false;
  for (const shape of Array.from(tree.children)) {
    if (shape.localName === 'pic') { hasPicture = true; continue; }
    const textBody = descendants(shape, 'txBody')[0];
    if (shape.localName === 'sp' && textBody) {
      const text = paragraphs(textBody);
      if (!text.length) continue;
      const placeholder = descendants(shape, 'ph')[0], type = placeholder ? attrByLocalName(placeholder, 'type') : '';
      if (!hasTitle && ['title', 'ctrTitle'].includes(type)) { blocks.push(`### ${text[0]}`); blocks.push(...text.slice(1)); hasTitle = true; }
      else blocks.push(...text);
      continue;
    }
    if (shape.localName === 'grpSp') {
      for (const nestedBody of descendants(shape, 'txBody')) blocks.push(...paragraphs(nestedBody));
      if (descendants(shape, 'pic').length) hasPicture = true;
      if (descendants(shape, 'graphicData').some(item => /chart/i.test(item.getAttribute('uri') ?? ''))) hasChart = true;
      else if (descendants(shape, 'graphicData').length) hasPicture = true;
    }
    const table = descendants(shape, 'tbl')[0];
    if (shape.localName === 'graphicFrame' && table) blocks.push(markdownTable(table));
    if (shape.localName === 'graphicFrame' && descendants(shape, 'graphicData').length) {
      const uri = descendants(shape, 'graphicData')[0].getAttribute('uri') ?? '';
      if (/chart/i.test(uri)) hasChart = true;
      else if (!table) hasPicture = true;
    }
  }
  return { markdown: blocks.filter(Boolean).join('\n\n'), hasPicture, hasChart };
}

export async function importPptxReference(data: ArrayBuffer | Uint8Array): Promise<ImportedPptxReference> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (!bytes.length || bytes.byteLength > MAX_ARCHIVE_BYTES) fail('请选择不超过 5 MB 的非空 PPTX 文件。');
  const { default: JSZip } = await import('jszip');
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes, { checkCRC32: false, createFolders: false }); }
  catch { return fail('无法读取 PPTX 压缩包；请确认文件未加密且格式有效。'); }
  validateArchive(zip);
  const budget = { used: 0 };
  const presentation = await readXml(zip, 'ppt/presentation.xml', budget);
  if (presentation.documentElement.localName !== 'presentation') fail('PPTX 演示文稿结构无效。');
  const relationships = await readXml(zip, 'ppt/_rels/presentation.xml.rels', budget);
  if (relationships.documentElement.localName !== 'Relationships') fail('PPTX 演示文稿关系无效。');
  const rels = new Map<string, string>();
  for (const relationship of descendants(relationships, 'Relationship')) {
    const id = relationship.getAttribute('Id'), type = relationship.getAttribute('Type');
    if (!id || rels.has(id)) fail('PPTX 演示文稿关系 ID 无效或重复。');
    if (type?.endsWith('/slide') && relationship.getAttribute('TargetMode') !== 'External') rels.set(id, slideTarget(relationship.getAttribute('Target') ?? ''));
  }
  const list = descendants(presentation, 'sldIdLst')[0];
  const slideIds = list ? children(list, 'sldId') : [];
  if (!slideIds.length || slideIds.length > MAX_SLIDES) fail('PPTX 幻灯片数量须为 1–120 页。');
  const markdown: string[] = [];
  let hasPicture = false, hasChart = false;
  for (const [index, slideId] of slideIds.entries()) {
    const id = Array.from(slideId.attributes).find(attribute => attribute.localName === 'id' && attribute.namespaceURI === REL_NS)?.value ?? '';
    const path = rels.get(id);
    if (!path) fail('PPTX 幻灯片引用无效或不受支持。');
    const result = renderSlide(await readXml(zip, path, budget), index);
    markdown.push(result.markdown); hasPicture ||= result.hasPicture; hasChart ||= result.hasChart;
    if (markdown.join('\n\n').length > MAX_TEXT_CHARS) fail('PPTX 提取文本超过 50000 个字符限制。');
  }
  const result = markdown.join('\n\n');
  if (!result.replace(/^## 幻灯片 \d+$/gm, '').trim()) fail('PPTX 幻灯片中没有可导入的文字。');
  const warnings: string[] = [];
  if (hasPicture) warnings.push('演示文稿含图片或非文本图形；这些内容未识别。');
  if (hasChart) warnings.push('演示文稿含嵌入图表；图表数据未提取或核验。');
  if (Object.keys(zip.files).some(name => /^ppt\/notesSlides\//i.test(name))) warnings.push('演讲者备注未导入。');
  if (Object.keys(zip.files).some(name => /^ppt\/(comments|commentAuthors)/i.test(name))) warnings.push('演示文稿批注未导入。');
  return { markdown: result, warnings };
}
