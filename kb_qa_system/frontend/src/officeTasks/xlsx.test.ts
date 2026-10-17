import JSZip from 'jszip';
import * as LegacyXLS from 'styled-exceljs';
import { expect, it } from 'vitest';
import { exportChartXlsx, exportMarkdownTableXlsx, markdownTableRows, parseFirstXlsxSheet } from './xlsx';
import { exportMarkdownTableXls } from './xls';

const workbook = (sheets: string, sheetXml: string, sharedStrings?: string, relationshipTarget = 'worksheets/sheet1.xml') => {
  const zip = new JSZip();
  zip.file('xl/workbook.xml', `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets}</sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${relationshipTarget}"/>${sharedStrings === undefined ? '' : '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>'}</Relationships>`);
  zip.file('xl/worksheets/sheet1.xml', sheetXml);
  if (sharedStrings !== undefined) zip.file('xl/sharedStrings.xml', sharedStrings);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
};

const sheet = (rows: string) => `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
const table = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>收入</t></is></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>甲</t></is></c></row>';
const strings = '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>分类</t></si></sst>';

it('reads shared and inline strings, numbers and sparse cell addresses', async () => {
  const bytes = await workbook('<sheet name="数据表" sheetId="1" r:id="rId1"/>', sheet(table), strings);
  await expect(parseFirstXlsxSheet(bytes)).resolves.toEqual({ csv: '分类,收入\n,\n甲,', sheetName: '数据表' });
});

it('chooses the first visible sheet and rejects formulas and spreadsheet errors', async () => {
  const hidden = '<sheet name="隐藏" sheetId="1" state="hidden" r:id="rId1"/><sheet name="可见" sheetId="2" r:id="rId1"/>';
  await expect(parseFirstXlsxSheet(await workbook(hidden, sheet(table), strings))).resolves.toMatchObject({ sheetName: '可见' });
  await expect(parseFirstXlsxSheet(await workbook('<sheet name="隐藏" sheetId="1" state="veryHidden" r:id="rId1"/>', sheet(table), strings))).rejects.toThrow('工作表');
  for (const cell of ['<c r="B2"><f>1+1</f><v>2</v></c>', '<c r="B2" t="e"><v>#VALUE!</v></c>']) {
    const bytes = await workbook('<sheet name="数据" sheetId="1" r:id="rId1"/>', sheet(`<row r="1"><c r="A1" t="inlineStr"><is><t>分类</t></is></c><c r="B1" t="inlineStr"><is><t>值</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>甲</t></is></c>${cell}</row>`));
    await expect(parseFirstXlsxSheet(bytes)).rejects.toThrow();
  }
});

it('rejects merged cells, unsafe relationships, damaged XML and invalid shared-string indexes', async () => {
  const base = '<sheet name="数据" sheetId="1" r:id="rId1"/>';
  await expect(parseFirstXlsxSheet(await workbook(base, `${sheet(table).replace('</worksheet>', '<mergeCells><mergeCell ref="A1:B1"/></mergeCells></worksheet>')}`, strings))).rejects.toThrow('合并');
  await expect(parseFirstXlsxSheet(await workbook(base, sheet(table), strings, '../outside.xml'))).rejects.toThrow();
  await expect(parseFirstXlsxSheet(await workbook(base, '<worksheet><sheetData>', strings))).rejects.toThrow();
  await expect(parseFirstXlsxSheet(await workbook(base, sheet(table.replace('<v>0</v>', '<v>4</v>')), strings))).rejects.toThrow('索引');
});

it('enforces row, column, archive and compressed-expansion limits', async () => {
  const base = '<sheet name="数据" sheetId="1" r:id="rId1"/>';
  const rows = Array.from({ length: 52 }, (_, index) => `<row r="${index + 1}"><c r="A${index + 1}" t="inlineStr"><is><t>${index ? '甲' : '分类'}</t></is></c><c r="B${index + 1}"><v>${index}</v></c></row>`).join('');
  await expect(parseFirstXlsxSheet(await workbook(base, sheet(rows)))).rejects.toThrow('50');
  const columns = '<row r="1"><c r="A1" t="inlineStr"><is><t>分类</t></is></c><c r="M1" t="inlineStr"><is><t>值</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>甲</t></is></c><c r="M2"><v>1</v></c></row>';
  await expect(parseFirstXlsxSheet(await workbook(base, sheet(columns)))).rejects.toThrow('12 列');
  const tooLarge = new JSZip();
  tooLarge.file('xl/workbook.xml', 'x'); tooLarge.file('extra.bin', 'x'.repeat(2_000_001));
  await expect(parseFirstXlsxSheet(await tooLarge.generateAsync({ type: 'uint8array', compression: 'STORE' }))).rejects.toThrow('2 MB');
  const bomb = new JSZip();
  bomb.file('xl/workbook.xml', 'x'.repeat(2_000_000));
  await expect(parseFirstXlsxSheet(await bomb.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 9 } }))).rejects.toThrow();
});

it('exports bounded chart data as a workbook with literal text cells and numeric series', async () => {
  const bytes = await exportChartXlsx({ title: "Quarter/[Team]*'s Results", csv: '分类,值\n=1+1,1.25', categoryColumn: 0, valueColumn: 1, chartType: 'bar', unit: '件' });
  await expect(parseFirstXlsxSheet(bytes)).resolves.toEqual({ csv: '分类,值\n=1+1,1.25', sheetName: "Quarter  Team  's Results" });
  const zip = await JSZip.loadAsync(bytes), sheetXml = await zip.file('xl/worksheets/sheet1.xml')!.async('text');
  expect(sheetXml).toContain('<c r="A2" t="inlineStr"><is><t xml:space="preserve">=1+1</t></is></c>');
  expect(sheetXml).toContain('<c r="B2"><v>1.25</v></c>');
  expect(sheetXml).not.toMatch(/<f(?:\s|>)/);
  await expect(exportChartXlsx({ title: 'bad', csv: '分类,值\na,=1+1', categoryColumn: 0, valueColumn: 1, chartType: 'bar', unit: '' })).rejects.toThrow('公式');
  await expect(exportChartXlsx({ title: 'bad', csv: '分类,值\n\uFFFF,1', categoryColumn: 0, valueColumn: 1, chartType: 'bar', unit: '' })).rejects.toThrow('XML');
});
it('exports the selected scatter X column as a numeric cell', async () => {
  const bytes = await exportChartXlsx({ title: '散点', csv: 'X,Y\n1.5,2\n3,4', categoryColumn: 0, valueColumn: 1, chartType: 'scatter', unit: '' });
  const zip = await JSZip.loadAsync(bytes), sheetXml = await zip.file('xl/worksheets/sheet1.xml')!.async('text');
  expect(sheetXml).toContain('<c r="A2"><v>1.5</v></c>');
  expect(sheetXml).toContain('<c r="B2"><v>2</v></c>');
});

it('exports the first Markdown table as literal workbook cells and rejects missing or oversized tables', async () => {
  const content = '# 报告\n\n| 指标 | 数值 |\n| --- | ---: |\n| 增长 | =1+1 |\n| 备注 | 100% |';
  expect(markdownTableRows(content)).toEqual([['指标', '数值'], ['增长', '=1+1'], ['备注', '100%']]);
  const bytes = await exportMarkdownTableXlsx(content, '经营/报告');
  await expect(parseFirstXlsxSheet(bytes)).resolves.toEqual({ csv: '指标,数值\n增长,=1+1\n备注,100%', sheetName: '经营 报告' });
  const zip = await JSZip.loadAsync(bytes), sheetXml = await zip.file('xl/worksheets/sheet1.xml')!.async('text');
  expect(sheetXml).toContain('<c r="B2" t="inlineStr"><is><t xml:space="preserve">=1+1</t></is></c>');
  expect(sheetXml).not.toMatch(/<f(?:\s|>)/);
  await expect(exportMarkdownTableXlsx('# 没有表格', '空表')).rejects.toThrow('没有可导出的表格');
  expect(() => markdownTableRows(`| A | B |\n| --- | --- |\n${Array.from({ length: 51 }, () => '| x | y |').join('\n')}`)).toThrow('50 行');
});

it('exports a real BIFF8 XLS workbook with Unicode text cells and no formulas', async () => {
  const bytes = await exportMarkdownTableXls('# 报告\n\n| 指标 | 数值 |\n| --- | --- |\n| 增长 | =1+1 |', '经营/报告');
  expect(Array.from(bytes.slice(0, 8))).toEqual([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const workbook = LegacyXLS.read(bytes, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  expect(sheetName).toBe('经营 报告');
  expect(LegacyXLS.utils.sheet_to_json(sheet, { header: 1, raw: false })).toEqual([
    ['指标', '数值'],
    ['增长', '=1+1'],
  ]);
  expect(sheet.B2).toMatchObject({ t: 's', v: '=1+1' });
  expect(sheet.B2.f).toBeUndefined();
  await expect(exportMarkdownTableXls('# 没有表格', '空表')).rejects.toThrow('没有可导出的表格');
});
