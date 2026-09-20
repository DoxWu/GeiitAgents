import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
const output = path.resolve('../../.tools/local-knowledge-qa');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(output, 'webview-local-kb-'));
const app = spawn(path.resolve('src-tauri/target/release/geiit-workbench.exe'), [], {
  windowsHide: true, stdio: 'ignore', env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=19228' },
});
let browser;
const metrics = {};
try {
  for (let attempt = 0; attempt < 30; attempt++) {
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:19228', { timeout: 1000 }); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  if (!browser) throw new Error('Desktop WebView did not become available');
  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.waitForEvent('page');
  const requests = [], errors = [];
  context.on('request', request => requests.push(request.url()));
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('link', { name: '本地知识库', exact: true }).click();
  await expect(page.getByRole('button', { name: '启用模型 / 按配置重建' })).toBeEnabled();
  expect(requests.filter(url => /huggingface|embedding.worker|\.wasm/.test(url))).toEqual([]);
  const start = Date.now();
  await page.getByRole('button', { name: '启用模型 / 按配置重建' }).click();
  const log = setInterval(async () => console.log(await page.getByRole('status').allTextContents().catch(() => [])), 15000);
  try {
    await Promise.race([
      expect(page.getByRole('button', { name: '选择文件并建立索引' })).toBeEnabled({ timeout: 600000 }),
      page.getByRole('alert').waitFor({ state: 'visible', timeout: 600000 }).then(async () => { throw new Error(await page.getByRole('alert').innerText()); }),
    ]);
  } finally { clearInterval(log); }
  metrics.coldEnableMs = Date.now() - start;
  await page.getByLabel('选择本地文档').setInputFiles({ name: '桌面验证.txt', mimeType: 'text/plain', buffer: Buffer.from('新员工需要完成安全培训，并向人事提交紧急联系人。') });
  await expect(page.getByRole('status')).toContainText('导入完成', { timeout: 60000 });
  await page.getByLabel('本地检索问题').fill('新员工需要提交什么信息？');
  await page.getByRole('button', { name: '本地检索', exact: true }).click();
  await expect(page.locator('.lk-hit').first()).toContainText('紧急联系人', { timeout: 60000 });
  await page.screenshot({ path: path.join(output, 'native-results.png'), fullPage: true });
  await page.getByRole('button', { name: '关闭本地模型', exact: true }).click();
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('button', { name: '启用模型 / 按配置重建' })).toBeEnabled();
  const cached = Date.now();
  await page.getByRole('button', { name: '启用模型 / 按配置重建' }).click();
  await expect(page.getByRole('button', { name: '选择文件并建立索引' })).toBeEnabled({ timeout: 60000 });
  metrics.offlineCachedEnableMs = Date.now() - cached;
  await page.getByLabel('本地检索问题').fill('新员工需要完成什么培训？');
  await page.getByRole('button', { name: '本地检索', exact: true }).click();
  await expect(page.locator('.lk-hit').first()).toContainText('安全培训', { timeout: 60000 });
  expect(requests.filter(url => url.includes('/api/v1/'))).toEqual([]);
  expect(errors).toEqual([]);
  metrics.scope = 'Actual Windows release exe, isolated WebView2 profile, real E5 CPU/WASM; offline reload and cached inference passed.';
  await writeFile(path.join(output, 'native-metrics.json'), JSON.stringify(metrics, null, 2));
  console.log(JSON.stringify(metrics));
} finally { if (browser) await browser.close(); app.kill(); }
