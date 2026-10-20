// Word-based pagination QA. All content and model responses are synthetic.
import { chromium, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readVaultCiphertext } from './vault-qa.mjs';
import { docxRegressionFixture } from '../src/officeTasks/docxRegressionFixture.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(root, '../../.tools/docx-pagination-qa');
const run = promisify(execFile);
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'result.json'), JSON.stringify({ automatedChecksPassed: false, visualReview: 'pending' }));
const paragraphs = Array.from({ length: 48 }, (_, i) => `Record ${i + 1} documents the quarterly operations review. The synthetic operations team compared planned workload with completed requests, checked ownership and due dates, and wrote the result in a stable order so readers can trace each finding back to its section. Follow-up owners confirmed the source row, repeated the arithmetic using the attached values, and left unresolved items explicitly marked for the next review. This paragraph is intentionally long enough to exercise real Word wrapping and natural page breaks without relying on fixed-height boxes or manual page breaks.`);
const body = Array.from({ length: 8 }, (_, section) => `\n\n## ${section + 1}. Operations Section ${section + 1}\n\n${paragraphs.slice(section * 6, section * 6 + 6).join('\n\n')}\n\n| Work item | Owner | Status |\n| --- | --- | --- |\n| Intake review ${section + 1} | Operations | Complete |\n| Quality review ${section + 1} | Assurance | In progress |\n| Release check ${section + 1} | Service team | Scheduled |`).join('');
const markdown = `# Quarterly Operations Review\n\nThis synthetic report checks natural pagination for the business DOCX export. It contains repeated operational records, tables, headings, and list items. The fixture contains no customer information.\n\n## Review Summary\n\nThe team completed its planned review cycle. Sections keep source order, separate evidence from follow-up, and avoid fixed page breaks so Word paginates naturally.\n\n- 48 synthetic review records\n- Eight review sections with three-row tables\n- No external images, links, or embedded files${body}\n\n## Final Checks\n\nThe release owner confirmed that each unresolved item has an owner and next review date. The next cycle will compare updated findings with this report.`;
const fixtures = [
  { name: 'quarterly-operations-review', title: 'Quarterly Operations Review', markdown, font: 'Arial', margin: '0.75', tables: 8 },
  { name: 'chinese-long-table', title: '长文档回归样例', markdown: docxRegressionFixture(), font: 'Microsoft YaHei', margin: '1.5', tables: 1 },
  { name: 'enhanced-layout', title: '排版增强验收', markdown: '# 排版增强验收\n\n## 项目概要\n\n这份合成报告验证页眉、页脚页码和可更新目录。\n\n## 验收明细\n\n| 项目 | 状态 |\n| --- | --- |\n| 合成任务 | 完成 |\n\n<!-- pagebreak -->\n\n## 后续计划\n\n手动分页后内容完整保留。', font: 'Microsoft YaHei', margin: '0.75', tables: 1, enhanced: true },
];
const results = [];
const user = { id: 902, username: 'pagination-fixture', email: 'pagination@example.test', is_active: true, is_superuser: false, user_type: 'regular', created_at: '' };
const browser = await chromium.launch({ headless: true }); let context;
try {
  context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 960 } });
  const page = await context.newPage(), errors = [], modelRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/auth/me')) return route.fulfill({ json: user });
    if (url.pathname.endsWith('/private-models/account')) return route.fulfill({ json: { available: true, model: 'pagination-fixture-model' } });
    if (url.pathname.endsWith('/private-models/account/complete/stream')) {
      modelRequests.push(route.request().postDataJSON());
      const content = fixtures[modelRequests.length - 1]?.markdown;
      if (!content) throw new Error('Unexpected model request');
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: ' + JSON.stringify({ type: 'chunk', content }) + '\n\n'
        + 'data: ' + JSON.stringify({ type: 'done', model: 'pagination-fixture-model', content, finish_reason: 'stop' }) + '\n\n' });
    }
    return route.fulfill({ json: {} });
  });
  await page.routeWebSocket('**/ws/notifications', () => {});
  await page.goto(process.env.DOCX_QA_URL || 'http://127.0.0.1:1425/workbench');
  await page.evaluate(user => {
    localStorage.setItem('kb_auth_tokens', JSON.stringify({ access_token: 'synthetic-pagination-token', refresh_token: 'synthetic-pagination-token' }));
    localStorage.setItem('kb_auth_user', JSON.stringify(user));
  }, user);
  await page.reload();
  await page.getByLabel('解锁口令', { exact: true }).fill('pagination-qa-1234');
  await page.getByLabel('确认口令', { exact: true }).fill('pagination-qa-1234');
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await page.getByRole('tab', { name: '任务', exact: true }).click();
  for (const [index, fixture] of fixtures.entries()) {
  const fixtureOutput = path.join(output, fixture.name);
  await mkdir(fixtureOutput, { recursive: true });
  await page.getByLabel('文档标题', { exact: true }).fill(fixture.title);
  await page.getByLabel('生成要求', { exact: true }).fill('保留所有章节和记录，按正式营运审查报告输出。');
  await page.getByLabel(/我允许本次/).check();
  await page.getByRole('button', { name: '开始生成' }).click();
  await expect(page.getByRole('region', { name: '任务详情' }).getByRole('heading', { name: fixture.title, exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '任务详情' })).toContainText('已完成');
  expect(modelRequests).toHaveLength(index + 1);
  await page.getByText('页面与字体', { exact: true }).click();
  await page.getByLabel('Word 纸张').selectOption('A4');
  await page.getByLabel('Word 字体').selectOption(fixture.font);
  await page.getByLabel('Word 字号').selectOption('11');
  await page.getByLabel('Word 行距').selectOption('1.15');
  await page.getByLabel('Word 页边距').selectOption(fixture.margin);
  await page.getByLabel('Word 自动目录').setChecked(Boolean(fixture.enhanced));
  await page.getByLabel('Word 页码').setChecked(Boolean(fixture.enhanced));
  await page.getByLabel('Word 页眉文字').fill(fixture.enhanced ? '合成项目 · 排版验收' : '');
  const pending = page.waitForEvent('download', { timeout: 40000 });
  await page.getByRole('button', { name: '导出 DOCX', exact: true }).click();
  const download = await pending, docxPath = path.join(fixtureOutput, `${fixture.name}.docx`);
  await download.saveAs(docxPath);
  const pdfPath = path.join(fixtureOutput, `${fixture.name}-word.pdf`);
  const word = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/render-docx-with-word.ps1'), '-InputDocx', docxPath, '-OutputPdf', pdfPath], { encoding: 'utf8', windowsHide: true, timeout: 180000 });
  const metrics = JSON.parse(word.stdout.trim().split(/\r?\n/).at(-1));
  const pdf = await getDocument({ data: new Uint8Array(await readFile(pdfPath)), useSystemFonts: true }).promise;
  expect(pdf.numPages).toBe(metrics.pages); expect(metrics.pages).toBeGreaterThanOrEqual(fixture.enhanced ? 3 : 5); expect(metrics.paragraphs).toBeGreaterThan(fixture.enhanced ? 10 : 100); expect(metrics.tables).toBe(fixture.tables);
  const renderedPages = [], pageTexts = [], tablePages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const pageProxy = await pdf.getPage(pageNumber), viewport = pageProxy.getViewport({ scale: 1.45 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height)), canvasContext = canvas.getContext('2d');
    canvasContext.fillStyle = '#fff'; canvasContext.fillRect(0, 0, canvas.width, canvas.height);
    await pageProxy.render({ canvasContext, viewport }).promise;
    const textContent = await pageProxy.getTextContent();
    const items = textContent.items.filter(item => 'str' in item && item.str.trim());
    const pageText = items.map(item => item.str).join('');
    expect(items.length).toBeGreaterThan(0);
    if (index === 0) expect(items[0].str.trim()).not.toBe('breaks.');
    const unscaled = pageProxy.getViewport({ scale: 1 }), horizontalMargin = Number(fixture.margin) * 72;
    for (const item of items) {
      expect(item.transform[4]).toBeGreaterThanOrEqual(horizontalMargin - 3);
      expect(item.transform[4] + item.width).toBeLessThanOrEqual(unscaled.width - horizontalMargin + 3);
      expect(item.transform[5]).toBeGreaterThan(0); expect(item.transform[5]).toBeLessThan(unscaled.height);
    }
    pageTexts.push(pageText);
    if (/行-\d+/.test(pageText)) {
      expect(pageText).toContain('编号'); expect(pageText).toContain('工作说明'); expect(pageText).toContain('状态');
      tablePages.push(pageNumber);
    }
    const pixels = canvasContext.getImageData(0, 0, canvas.width, canvas.height).data;
    let darkPixels = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 180 && pixels[i + 1] < 180 && pixels[i + 2] < 180) darkPixels++;
    expect(darkPixels).toBeGreaterThan(200);
    const imagePath = path.join(fixtureOutput, `page-${String(pageNumber).padStart(2, '0')}.png`);
    await writeFile(imagePath, canvas.toBuffer('image/png'));
    renderedPages.push({ page: pageNumber, width: canvas.width, height: canvas.height, darkPixels, path: imagePath }); pageProxy.cleanup();
  }
  await pdf.destroy();
  const extracted = pageTexts.join('');
  if (index === 0) {
    for (let record = 1; record <= 48; record++) expect(extracted).toContain(`Record ${record} documents`);
    expect(extracted).toContain('Final Checks');
  } else if (index === 1) {
    for (let record = 1; record <= 18; record++) expect(extracted).toContain(`段落-${record}：`);
    for (let row = 1; row <= 120; row++) expect(extracted).toContain(`行-${row}`);
    for (let line = 1; line <= 80; line++) expect(extracted).toContain(`line_${line}:`);
    expect(extracted).toContain('结束标记：全文应完整保留。'); expect(tablePages.length).toBeGreaterThan(1);
  } else {
    expect(extracted.replace(/\s+/g, '')).toContain('合成项目·排版验收');
    expect(extracted).toContain('后续计划');
    expect(extracted).toContain('手动分页后内容完整保留。');
    expect(metrics.tableOfContents).toBe(1);
    for (const text of pageTexts) expect(text).toMatch(/第\s*\d+\s*页/);
  }
  const encrypted = await readVaultCiphertext(page);
  expect(JSON.parse(encrypted).ciphertext).toBeTruthy(); expect(encrypted).not.toContain(fixture.markdown); expect(errors).toEqual([]);
  results.push({ fixture: fixture.name, renderer: 'Microsoft Word', wordPages: metrics.pages, pdfPages: renderedPages.length, paragraphs: metrics.paragraphs, tables: metrics.tables, repeatedHeaderPages: tablePages, renderedPages });
  console.log(JSON.stringify({ automatedChecksPassed: true, fixture: fixture.name, pages: metrics.pages, repeatedHeaderPages: tablePages, pngPages: renderedPages.length }));
  }
  expect(modelRequests).toHaveLength(fixtures.length);
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ automatedChecksPassed: true, visualReview: 'pending', modelRequests: modelRequests.length, fixtures: results }, null, 2));
} finally { await context?.close(); await browser.close(); }
