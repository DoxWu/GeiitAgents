// Run against a production preview. Real E5/WASM inference; no embedding mocks.
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { pdfFixture } from './pdf-fixture.mjs';
const output = path.resolve(process.env.LOCAL_KB_QA_OUTPUT ?? '../../.tools/local-knowledge-qa');
const previewOrigin = new URL(process.env.LOCAL_KB_QA_URL ?? 'http://127.0.0.1:1422').origin;
await mkdir(output, { recursive: true });
const context = await chromium.launchPersistentContext(path.join(output, 'browser-profile'), { headless: true, viewport: { width: 1200, height: 920 } });
const page = await context.newPage();
const requests = [], errors = [], consoleErrors = [], modelResponses = [], failedRequests = [];
context.on('request', request => requests.push(request.url()));
context.on('requestfailed', request => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
context.on('response', async response => {
  if (!response.url().includes('huggingface.co/') && !new URL(response.url()).pathname.startsWith('/models/')) return;
  const contentType = response.headers()['content-type'] ?? '';
  const entry = { url: response.url(), status: response.status(), contentType };
  if (contentType.includes('text/html')) entry.bodyPrefix = (await response.text().catch(() => '')).slice(0, 200);
  modelResponses.push(entry);
});
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
// Apply the actual nginx CSP, since vite preview does not serve security headers.
const securityHeaders = await readFile('security-headers.conf', 'utf8');
const csp = securityHeaders.match(/add_header Content-Security-Policy "([^"]+)"/)?.[1];
if (!csp) throw new Error('The Nginx Content-Security-Policy header is missing.');
await context.route(`${previewOrigin}/**`, async route => {
  const response = await route.fetch();
  await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': csp } });
});
const metrics = {};
try {
  await page.goto(`${previewOrigin}/local-knowledge`);
  // This is a dedicated QA profile, never the user's browser profile.
  await page.evaluate(async cold => {
    if (cold) await caches.delete('geiit-local-models-v1');
    await new Promise((resolve, reject) => { const r = indexedDB.deleteDatabase('geiit-local-knowledge-v1'); r.onsuccess = resolve; r.onerror = reject; });
  }, process.env.LOCAL_KB_COLD === '1');
  await page.reload();
  metrics.initialModelCacheEntries = await page.evaluate(async () => (await (await caches.open('geiit-local-models-v1')).keys()).length);
  await expect(page.getByRole('button', { name: '启用模型 / 按配置重建' })).toBeEnabled();
  expect(requests.filter(url => /huggingface|hf\.co|embedding.worker|\.wasm/.test(url))).toEqual([]);
  await page.screenshot({ path: path.join(output, 'desktop-before-enable.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1200, height: 920 });
  const start = Date.now();
  await page.getByRole('button', { name: '启用模型 / 按配置重建' }).click();
  const report = setInterval(async () => console.log(await page.getByRole('status').allTextContents().catch(() => [])), 15000);
  try { await Promise.race([
    expect(page.getByRole('button', { name: '选择文件并建立索引' })).toBeEnabled({ timeout: 600000 }),
    page.getByRole('alert').waitFor({ state: 'visible', timeout: 600000 }).then(async () => { throw new Error(await page.getByRole('alert').innerText()); }),
  ]); }
  finally { clearInterval(report); }
  metrics.firstEnableMs = Date.now() - start;
  const indexStart = Date.now();
  const word = new JSZip();
  word.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>合同签订需要法务审核和负责人批准。</w:t><w:drawing/></w:r></w:p></w:body></w:document>');
  const slides = new JSZip();
  slides.file('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="s1"/></p:sldIdLst></p:presentation>');
  slides.file('ppt/_rels/presentation.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="s1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>');
  slides.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>项目周报需要更新里程碑和风险清单。</a:t></a:r></a:p></p:txBody></p:sp><p:pic/></p:spTree></p:cSld></p:sld>');
  await page.getByLabel('选择本地文档').setInputFiles([
    { name: '报销制度.md', mimeType: 'text/markdown', buffer: Buffer.from('# 报销制度\n员工报销需提供发票、付款凭证与主管审批记录。出差结束后十个工作日内提交财务。') },
    { name: 'Engineering.txt', mimeType: 'text/plain', buffer: Buffer.from('Engineering deployments require passing tests and code review. Roll back a release if the health check fails.') },
    { name: '休假.txt', mimeType: 'text/plain', buffer: Buffer.from('年假申请应提前三个工作日提交，人事审核后通知申请人。') },
    { name: 'Security.pdf', mimeType: 'application/pdf', buffer: pdfFixture('Security audit requires quarterly access recertification and revoking former employee credentials.') },
    { name: '合同.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: await word.generateAsync({ type: 'nodebuffer' }) },
    { name: '周报.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer: await slides.generateAsync({ type: 'nodebuffer' }) },
  ]);
  await expect(page.getByRole('status')).toContainText('导入完成', { timeout: 120000 });
  metrics.index6DocumentsMs = Date.now() - indexStart;
  const extracted = await page.evaluate(async () => new Promise((resolve, reject) => {
    const request = indexedDB.open('geiit-local-knowledge-v1', 1);
    request.onerror = reject; request.onsuccess = () => {
      const db = request.result, tx = db.transaction('index', 'readonly'), value = tx.objectStore('index').get('active');
      tx.oncomplete = () => { db.close(); resolve(value.result.documents); }; tx.onerror = reject;
    };
  }));
  expect(extracted.find(doc => doc.name === 'Security.pdf').text).toContain('quarterly access recertification');
  expect(extracted.find(doc => doc.name === '合同.docx').text).toContain('法务审核');
  expect(extracted.find(doc => doc.name === '周报.pptx').text).toContain('里程碑');
  expect(extracted.filter(doc => doc.importWarnings?.length)).toHaveLength(3);
  const queryStart = Date.now();
  await page.getByLabel('本地检索问题').fill('报销需要什么材料？');
  await page.getByRole('button', { name: '本地检索', exact: true }).click();
  await expect(page.locator('.lk-hit').first()).toContainText('报销制度.md', { timeout: 60000 });
  metrics.queryMs = Date.now() - queryStart;
  await page.screenshot({ path: path.join(output, 'desktop-results.png'), fullPage: true });
  await page.getByRole('button', { name: '关闭本地模型', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: '删除 报销制度.md', exact: true })).toBeVisible();
  const pdfFile = page.locator('.lk-file').filter({ hasText: 'Security.pdf' });
  await pdfFile.locator('summary').click();
  await expect(pdfFile).toContainText('图片、表单和批注不会保留');
  await pdfFile.getByText('PDF 仅提取可选中的文字；页面版式、图片、表单和批注不会保留。').scrollIntoViewIfNeeded();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, 'import-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1200, height: 920 });
  await expect(page.getByRole('button', { name: '选择文件并建立索引' })).toBeDisabled();
  // Stay on the loaded page to test cached model restart with external network fully blocked.
  // Web app shell offline reload requires a future service worker; Tauri ships these assets.
  await context.route('https://**/*', route => route.abort());
  const externalBefore = requests.filter(url => url.startsWith('https:')).length;
  const cachedStart = Date.now();
  await page.getByRole('button', { name: '启用模型 / 按配置重建' }).click();
  await expect(page.getByRole('button', { name: '选择文件并建立索引' })).toBeEnabled({ timeout: 120000 });
  metrics.cachedEnableMs = Date.now() - cachedStart;
  await page.getByLabel('本地检索问题').fill('What is required before a deployment?');
  await page.getByRole('button', { name: '本地检索', exact: true }).click();
  await expect(page.locator('.lk-hit').first()).toContainText('Engineering.txt', { timeout: 60000 });
  await page.getByLabel('本地检索问题').fill('What does the security audit require for employee access?');
  await page.getByRole('button', { name: '本地检索', exact: true }).click();
  await expect(page.locator('.lk-hit').first()).toContainText('Security.pdf', { timeout: 60000 });
  await expect(page.locator('.lk-hit').first()).toContainText('quarterly access recertification');
  expect(requests.filter(url => url.startsWith('https:')).length).toBe(externalBefore);
  const second = await context.newPage();
  await second.goto(`${previewOrigin}/local-knowledge`);
  await second.getByRole('button', { name: '启用模型 / 按配置重建' }).click();
  await expect(second.getByRole('alert')).toContainText('另一个窗口');
  await second.close();
  await page.getByLabel('选择本地文档').setInputFiles({ name: '取消测试.txt', mimeType: 'text/plain', buffer: Buffer.from('这是一份需要中途取消的长文档，用于确认原索引保留。'.repeat(4000)) });
  await expect(page.getByRole('status')).toContainText('索引', { timeout: 60000 });
  await page.getByRole('button', { name: '取消并关闭模型' }).click();
  await expect(page.getByRole('button', { name: '删除 取消测试.txt', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('6 个文件 · 6 个片段')).toBeVisible();
  const backup = page.getByRole('region', { name: '本地知识库备份与恢复' });
  await backup.getByLabel('备份口令', { exact: true }).fill('fixture-only-password');
  await backup.getByLabel('确认备份口令（仅导出）').fill('fixture-only-password');
  const downloadReady = page.waitForEvent('download');
  await backup.getByRole('button', { name: '导出加密备份' }).click();
  const backupPath = path.join(output, 'office-import.geiitkb');
  await (await downloadReady).saveAs(backupPath);
  expect((await readFile(backupPath, 'utf8'))).not.toContain('Security.pdf');
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '删除全部本地文档' }).click();
  await expect(page.getByText('尚未添加文档')).toBeVisible();
  await backup.getByLabel('备份口令', { exact: true }).fill('fixture-only-password');
  await backup.getByLabel('选择知识库备份').setInputFiles(backupPath);
  await expect(backup.getByText('待恢复：6 个文件 · 6 个片段')).toBeVisible();
  await backup.getByRole('button', { name: '确认替换本地库' }).click();
  await expect(page.getByText('6 个文件 · 6 个片段')).toBeVisible();
  for (const name of ['Security.pdf', '合同.docx', '周报.pptx']) {
    const row = page.locator('.lk-file').filter({ hasText: name });
    await expect(row.locator('summary')).toHaveText('导入注意事项');
    await expect(row).toContainText('不代表原文件位置');
  }
  metrics.encryptedBackupRestored = true;
  // No cloud business API receives files, queries or embeddings.
  expect(requests.filter(url => url.includes('/api/v1/'))).toEqual([]);
  expect(errors).toEqual([]);
  metrics.modelNetworkRequests = requests.filter(url => url.includes('huggingface.co')).length;
  metrics.scope = 'Headless Chromium, real CPU/WASM E5; six small MD/TXT/PDF/DOCX/PPTX documents. Real local parsers, persisted omissions, PDF retrieval with external network blocked, actual indexed documents encrypted and restored; not OCR or low-end hardware benchmark.';
  await writeFile(path.join(output, 'metrics.json'), JSON.stringify(metrics, null, 2));
  console.log(JSON.stringify(metrics));
} catch (error) {
  console.log('Current status:', await page.getByRole('status').allTextContents());
  console.log('Current errors:', await page.getByRole('alert').allTextContents());
  console.log('Model responses:', JSON.stringify(modelResponses));
  console.log('Model requests:', JSON.stringify(requests.filter(url => /huggingface\.co|\.wasm|\.mjs/.test(url))));
  console.log('Failed requests:', JSON.stringify(failedRequests));
  console.log('Browser errors:', JSON.stringify(errors));
  console.log('Browser console:', JSON.stringify(consoleErrors));
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
  throw error;
} finally { await context.close(); }
