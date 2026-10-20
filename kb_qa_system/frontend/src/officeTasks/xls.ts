import * as XLSX from 'styled-exceljs';
import { markdownTableRows, normalizeSheetName } from './xlsx';

export const XLS_MIME = 'application/vnd.ms-excel';
export const XLS_DOCUMENT_CONVERTER_VERSION = 'markdown-xls-biff8/2';
const MAX_OUTPUT_BYTES = 4_000_000;

function cellAddress(row: number, column: number): string {
  let index = column + 1, letters = '';
  while (index) { const remainder = (index - 1) % 26; letters = String.fromCharCode(65 + remainder) + letters; index = Math.floor((index - 1) / 26); }
  return `${letters}${row + 1}`;
}

function spreadsheetCell(value: string, row: number) {
  const numeric = Number(value);
  if (row > 0 && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
    && Number.isFinite(numeric)
    && (!Number.isInteger(numeric) || Math.abs(numeric) <= Number.MAX_SAFE_INTEGER)) {
    return { t: 'n', v: numeric };
  }
  return { t: 's', v: value };
}

export async function exportMarkdownTableXls(content: string, title: string): Promise<Uint8Array> {
  const rows = markdownTableRows(content);
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  for (let row = 0; row < rows.length; row++) for (let column = 0; column < rows[row].length; column++) {
    const address = cellAddress(row, column), value = rows[row][column];
    sheet[address] = spreadsheetCell(value, row);
  }
  sheet['!cols'] = rows[0].map((_, column) => ({ wch: Math.max(10, Math.min(42, ...rows.map(row => Array.from(row[column] ?? '').length + 2))) } as never));
  XLSX.utils.book_append_sheet(workbook, sheet, normalizeSheetName(title));
  // This BIFF8 writer preserves data and column widths, but does not write styles or filters.
  // Shared strings avoid the legacy inline-label writer's 255-character truncation.
  const output = XLSX.write(workbook, { bookType: 'biff8', type: 'array', bookSST: true });
  const bytes = output instanceof Uint8Array
    ? new Uint8Array(output.buffer, output.byteOffset, output.byteLength)
    : output instanceof ArrayBuffer ? new Uint8Array(output) : null;
  if (!bytes?.length || bytes.byteLength > MAX_OUTPUT_BYTES) throw new Error('XLS 文件无效或超过安全大小限制。');
  return bytes;
}
