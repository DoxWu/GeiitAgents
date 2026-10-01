import type JSZip from 'jszip';
import { checkChart, parseChartCsv, type ChartInput } from './chart';

const MAX_ARCHIVE_BYTES = 2_000_000;
const MAX_ENTRY_COUNT = 256;
const MAX_UNCOMPRESSED_BYTES = 12_000_000;
const MAX_XML_BYTES = 8_000_000;
const MAX_ROWS = 51;
const MAX_COLUMNS = 12;
const MAX_CELL_CHARS = 2000;
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

export interface ParsedWorkbookSheet { csv: string; sheetName: string }
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function fail(message: string): never { throw new Error(message); }

function parseXml(source: string, expectedRoot: string): XMLDocument {
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(source)) fail('XLSX XML 不支持文档类型声明或实体。');
  const doc = new DOMParser().parseFromString(source, 'application/xml');
  if (doc.querySelector('parsererror') || doc.documentElement.localName !== expectedRoot) fail('XLSX 工作簿结构无效或 XML 已损坏。');
  return doc;
}

function descendants(node: ParentNode, localName: string): Element[] {
  return Array.from(node.querySelectorAll('*')).filter(element => element.localName === localName);
}

function relationshipId(sheet: Element): string {
  for (const attribute of Array.from(sheet.attributes)) if (attribute.localName === 'id' && attribute.namespaceURI === REL_NS) return attribute.value;
  return '';
}

function relationshipTarget(target: string): string {
  if (!target || target.includes('\\') || /[?#%:]/.test(target)) fail('XLSX 关系路径无效。');
  const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  const segments = path.split('/');
  if (segments[0] !== 'xl' || segments.some(segment => !segment || segment === '.' || segment === '..')) fail('XLSX 关系路径越出工作簿目录。');
  return path;
}

function readEntry(file: ZipEntry, budget: { used: number }, limit = MAX_XML_BYTES): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const stream = file.internalStream('uint8array'), chunks: Uint8Array[] = [];
    let length = 0, settled = false;
    const stop = (error: Error) => {
      if (settled) return;
      settled = true; stream.pause(); reject(error);
    };
    stream.on('data', chunk => {
      length += chunk.byteLength; budget.used += chunk.byteLength;
      if (length > limit || budget.used > MAX_UNCOMPRESSED_BYTES) { stop(new Error('XLSX 解压内容超过安全大小限制。')); return; }
      chunks.push(chunk);
    }).on('error', error => stop(new Error(`XLSX 条目无法解压：${error.message}`))).on('end', () => {
      if (settled) return;
      settled = true;
      const output = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
      resolve(output);
    });
    stream.resume();
  });
}

async function readText(zip: JSZip, path: string, budget: { used: number }, required = true): Promise<string | null> {
  const file = zip.file(path) as ZipEntry | null;
  if (!file) { if (required) fail(`XLSX 缺少必要条目：${path}`); return null; }
  const bytes = await readEntry(file, budget);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return fail(`XLSX 条目不是有效 UTF-8：${path}`); }
}

function csvField(value: string): string { return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value; }

function columnIndex(reference: string): { row: number; column: number } {
  const match = /^([A-Z]{1,3})([1-9]\d*)$/i.exec(reference);
  if (!match) fail('XLSX 单元格地址无效。');
  let column = 0;
  for (const char of match[1].toUpperCase()) column = column * 26 + char.charCodeAt(0) - 64;
  return { row: Number(match[2]), column: column - 1 };
}

function readSharedStrings(doc: XMLDocument): string[] {
  const items = descendants(doc, 'si');
  if (items.length > MAX_ROWS * MAX_COLUMNS * 4) fail('XLSX 共享字符串数量超过限制。');
  return items.map(item => descendants(item, 't').map(text => text.textContent ?? '').join(''));
}

function cellValue(cell: Element, sharedStrings: string[]): string {
  if (Array.from(cell.children).some(child => child.localName === 'f')) fail('XLSX 包含公式单元格；为避免使用未更新的公式缓存，请先在表格软件中另存为纯数值。');
  const type = cell.getAttribute('t') ?? '';
  if (type === 'inlineStr') return descendants(cell, 't').map(text => text.textContent ?? '').join('');
  const value = Array.from(cell.children).find(child => child.localName === 'v')?.textContent ?? '';
  if (type === 's') {
    const index = Number(value);
    if (!Number.isInteger(index) || index < 0 || index >= sharedStrings.length) fail('XLSX 共享字符串索引无效。');
    return sharedStrings[index];
  }
  if (type === 'e') fail('XLSX 包含错误值单元格，请先修正工作表。');
  if (type === 'b') return value === '1' ? 'TRUE' : value === '0' ? 'FALSE' : fail('XLSX 布尔值无效。');
  return value;
}

export async function parseFirstXlsxSheet(data: ArrayBuffer | Uint8Array): Promise<ParsedWorkbookSheet> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (!bytes.length || bytes.byteLength > MAX_ARCHIVE_BYTES) fail('请选择不超过 2 MB 的非空 XLSX 文件。');
  const { default: JSZip } = await import('jszip');
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes, { checkCRC32: false, createFolders: false }); }
  catch { return fail('无法读取 XLSX 压缩包；请确认文件未加密且格式有效。'); }
  const entries = Object.values(zip.files) as ZipEntry[];
  if (!entries.length || entries.length > MAX_ENTRY_COUNT) fail('XLSX 条目数量超过限制。');
  let declaredSize = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    if (entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name) fail('XLSX 包含不安全路径。');
    if (entry.name.startsWith('/') || entry.name.split('/').some(segment => segment === '..' || segment === '.')) fail('XLSX 包含不安全路径。');
    const size = entry._data?.uncompressedSize, compressed = entry._data?.compressedSize;
    if (!Number.isSafeInteger(size) || !Number.isSafeInteger(compressed) || size! < 0 || compressed! < 0) fail('XLSX 压缩包目录无效。');
    declaredSize += size!;
    if (declaredSize > MAX_UNCOMPRESSED_BYTES || size! > MAX_XML_BYTES || size! > Math.max(100_000, compressed! * 1000)) fail('XLSX 解压内容超过安全大小限制。');
  }
  const budget = { used: 0 };
  const workbookText = await readText(zip, 'xl/workbook.xml', budget);
  const relationshipsText = await readText(zip, 'xl/_rels/workbook.xml.rels', budget);
  const workbook = parseXml(workbookText!, 'workbook'), relationships = parseXml(relationshipsText!, 'Relationships');
  const rels = new Map<string, { type: string; target: string }>();
  for (const rel of descendants(relationships, 'Relationship')) {
    const id = rel.getAttribute('Id'), type = rel.getAttribute('Type'), target = rel.getAttribute('Target');
    if (!id || !type || rels.has(id)) fail('XLSX 工作簿关系无效。');
    rels.set(id, { type, target: relationshipTarget(target) });
  }
  const sheets = descendants(workbook, 'sheet');
  const selected = sheets.find(sheet => sheet.getAttribute('state') !== 'hidden' && sheet.getAttribute('state') !== 'veryHidden');
  if (!selected) fail('XLSX 工作簿没有工作表。');
  const sheetRel = rels.get(relationshipId(selected));
  if (!sheetRel?.type.endsWith('/worksheet')) fail('XLSX 第一个可见工作表关系无效。');
  const sheetText = await readText(zip, sheetRel.target, budget);
  const sheet = parseXml(sheetText!, 'worksheet');
  if (descendants(sheet, 'mergeCell').length) fail('XLSX 暂不支持合并单元格，请先取消合并后导入。');
  const sharedRel = [...rels.values()].find(rel => rel.type.endsWith('/sharedStrings'));
  const sharedText = sharedRel ? await readText(zip, sharedRel.target, budget, false) : null;
  const sharedStrings = sharedText ? readSharedStrings(parseXml(sharedText, 'sst')) : [];
  const sheetData = descendants(sheet, 'sheetData')[0];
  if (!sheetData) fail('XLSX 工作表没有表格数据。');
  const rows = new Map<number, string[]>(); let nextRow = 0, maxColumn = 0;
  for (const row of descendants(sheetData, 'row')) {
    const rowNumber = row.hasAttribute('r') ? Number(row.getAttribute('r')) : nextRow + 1;
    if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > MAX_ROWS || rows.has(rowNumber)) fail('XLSX 最多支持 50 条数据和 12 列，且不能包含重复行。');
    nextRow = rowNumber;
    const values: string[] = [];
    let nextColumn = 0;
    for (const cell of Array.from(row.children).filter(child => child.localName === 'c')) {
      const address = cell.hasAttribute('r') ? columnIndex(cell.getAttribute('r')!) : { row: rowNumber, column: nextColumn };
      if (address.row !== rowNumber || address.column < 0 || address.column >= MAX_COLUMNS) fail('XLSX 最多支持 12 列。');
      if (values[address.column] !== undefined) fail('XLSX 单元格地址重复。');
      const value = cellValue(cell, sharedStrings);
      if (value.length > MAX_CELL_CHARS) fail('XLSX 单元格最多 2000 个字符。');
      values[address.column] = value; nextColumn = address.column + 1; maxColumn = Math.max(maxColumn, nextColumn);
    }
    rows.set(rowNumber, values);
  }
  const maxRow = Math.max(...rows.keys());
  if (maxRow < 2 || maxColumn < 2) fail('XLSX 至少需要两列，并包含表头和一条数据。');
  const csv = Array.from({ length: maxRow }, (_, index) => {
    const values = rows.get(index + 1) ?? [];
    return Array.from({ length: maxColumn }, (_, column) => csvField(values[column] ?? '')).join(',');
  }).join('\n');
  if (csv.length > 100_000) fail('XLSX 转换后的表格超过 100000 个字符。');
  parseChartCsv(csv);
  return { csv, sheetName: selected.getAttribute('name')?.slice(0, 100) || 'Sheet1' };
}

function xmlText(value: string): string {
  if (Array.from(value).some(char => {
    const code = char.codePointAt(0)!;
    return !(code === 9 || code === 10 || code === 13 || code >= 0x20 && code <= 0xd7ff || code >= 0xe000 && code <= 0xfffd || code >= 0x10000 && code <= 0x10ffff);
  })) throw new Error('XLSX 文本包含 XML 不支持的字符。');
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;').replace(/\r/g, '&#13;');
}

function columnName(index: number): string {
  let value = index + 1, result = '';
  while (value) { const remainder = (value - 1) % 26; result = String.fromCharCode(65 + remainder) + result; value = Math.floor((value - 1) / 26); }
  return result;
}

function sheetName(title: string): string {
  const value = Array.from(title, char => {
    const code = char.charCodeAt(0);
    return '\\/*?:[]'.includes(char) || code < 32 ? ' ' : char;
  }).join('').replace(/^'+|'+$/g, '').trim().slice(0, 31);
  return value || '数据';
}

export async function exportChartXlsx(input: ChartInput): Promise<Uint8Array> {
  checkChart(input);
  const data = parseChartCsv(input.csv), numericColumns = new Set(input.valueColumns ?? [input.valueColumn]);
  const rows = [data.headers, ...data.rows];
  const sheetRows = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, columnIndex) => {
    const reference = `${columnName(columnIndex)}${rowIndex + 1}`;
    if (rowIndex > 0 && numericColumns.has(columnIndex)) return `<c r="${reference}"><v>${Number(value)}</v></c>`;
    return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`;
  }).join('')}</row>`).join('');
  const zipModule = await import('jszip'), zip = new zipModule.default();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlText(sheetName(input.title))}" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
