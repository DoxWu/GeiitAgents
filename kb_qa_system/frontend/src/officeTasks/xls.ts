import * as XLSX from 'styled-exceljs';
import { markdownTableRows, normalizeSheetName } from './xlsx';

export const XLS_MIME = 'application/vnd.ms-excel';
export const XLS_DOCUMENT_CONVERTER_VERSION = 'markdown-xls-biff8/1';
const MAX_OUTPUT_BYTES = 4_000_000;

export async function exportMarkdownTableXls(content: string, title: string): Promise<Uint8Array> {
  const rows = markdownTableRows(content);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), normalizeSheetName(title));
  const output = XLSX.write(workbook, { bookType: 'biff8', type: 'array' });
  const bytes = output instanceof Uint8Array
    ? new Uint8Array(output.buffer, output.byteOffset, output.byteLength)
    : output instanceof ArrayBuffer ? new Uint8Array(output) : null;
  if (!bytes?.length || bytes.byteLength > MAX_OUTPUT_BYTES) throw new Error('XLS 文件无效或超过安全大小限制。');
  return bytes;
}
