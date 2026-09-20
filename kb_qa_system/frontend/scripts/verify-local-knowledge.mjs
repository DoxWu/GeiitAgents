// Run against a production preview. Real E5/WASM inference; no embedding mocks.
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
const output = path.resolve('../../.tools/local-knowledge-qa');
await mkdir(output, { recursive: true });
const context = await chromium.launchPersistentContext(path.join(output, 'browser-profile'), { headless: true, viewport: { width: 1200, height: 920 } });
const page = await context.newPage();
const requests = [], errors = [];
context.on('request', request => requests.push(request.url()));
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') console.log('browser:', message.text()); });
// Apply the actual nginx CSP, since vite preview does not serve security headers.
const nginx = await readFile('nginx.conf', 'utf8');
const csp = nginx.match(/Content-Security-Policy "([^"]+)"/)[1];
await context.route('http://127.0.0.1:1422/**', async route => {
  const response = await route.fetch();
  await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': csp } });
});
const metrics = {};
try {
  await page.goto('http://127.0.0.1:1422/local-knowledge');
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
  await page.getByLabel('选择本地文档').setInputFiles([
    { name: '报销制度.md', mimeType: 'text/markdown', buffer: Buffer.from('# 报销制度\n员工报销需提供发票、付款凭证与主管审批记录。出差结束后十个工作日内提交财务。') },
    { name: 'Engineering.txt', mimeType: 'text/plain', buffer: Buffer.from('Engineering deployments require passing tests and code review. Roll back a release if the health check fails.') },
    { name: '休假.txt', mimeType: 'text/plain', buffer: Buffer.from('年假申请应提前三个工作日提交，人事审核后通知申请人。') },
  ]);
  await expect(page.getByRole('status')).toContainText('导入完成', { timeout: 120000 });
  metrics.index3DocumentsMs = Date.now() - indexStart;
  const queryStart = Date.now();
  await page.getByLabel('本地检索问题').fill('报销需要什么材料？');
  await page.getByRole('button', { name: '本地检索', exact: true }).click();
  await expect(page.locator('.lk-hit').first()).toContainText('报销制度.md', { timeout: 60000 });
  metrics.queryMs = Date.now() - queryStart;
  await page.screenshot({ path: path.join(output, 'desktop-results.png'), fullPage: true });
  await page.getByRole('button', { name: '关闭本地模型', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: '删除 报销制度.md', exact: true })).toBeVisible();
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
  expect(requests.filter(url => url.startsWith('https:')).length).toBe(externalBefore);
  const second = await context.newPage();
  await second.goto('http://127.0.0.1:1422/local-knowledge');
  await second.getByRole('button', { name: '启用模型 / 按配置重建' }).click();
  await expect(second.getByRole('alert')).toContainText('另一个窗口');
  await second.close();
  await page.getByLabel('选择本地文档').setInputFiles({ name: '取消测试.txt', mimeType: 'text/plain', buffer: Buffer.from('这是一份需要中途取消的长文档，用于确认原索引保留。'.repeat(4000)) });
  await expect(page.getByRole('status')).toContainText('索引', { timeout: 60000 });
  await page.getByRole('button', { name: '取消并关闭模型' }).click();
  await expect(page.getByRole('button', { name: '删除 取消测试.txt', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('3 个文件 · 3 个片段')).toBeVisible();
  // No cloud business API receives files, queries or embeddings.
  expect(requests.filter(url => url.includes('/api/v1/'))).toEqual([]);
  expect(errors).toEqual([]);
  metrics.modelNetworkRequests = requests.filter(url => url.includes('huggingface.co')).length;
  metrics.scope = 'Headless Chromium, CPU/WASM single thread; three small documents. Cached model with external network blocked; not low-end hardware benchmark.';
  await writeFile(path.join(output, 'metrics.json'), JSON.stringify(metrics, null, 2));
  console.log(JSON.stringify(metrics));
} catch (error) {
  console.log('Current status:', await page.getByRole('status').allTextContents());
  console.log('Current errors:', await page.getByRole('alert').allTextContents());
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
  throw error;
} finally { await context.close(); }
