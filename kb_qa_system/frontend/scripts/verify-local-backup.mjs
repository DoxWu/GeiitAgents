import { chromium, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
const output = path.resolve('../../.tools/local-backup-qa');
await mkdir(output, { recursive: true });
const native = process.env.LOCAL_BACKUP_NATIVE === '1';
let browser, context, app;
if (native) {
  app = spawn(path.resolve('src-tauri/target-dev/release/geiit-workbench.exe'), [], { windowsHide: true, stdio: 'ignore',
    env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: path.join(output, `webview-${Date.now()}`), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=19229' } });
  for (let attempt = 0; attempt < 30; attempt++) {
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:19229', { timeout: 1000 }); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  if (!browser) { app.kill(); throw new Error('Development desktop did not start'); }
  context = browser.contexts()[0];
} else {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1200, height: 950 } });
}
const page = native ? context.pages()[0] || await context.waitForEvent('page') : await context.newPage();
const requests = [], errors = [];
context.on('request', request => requests.push(request.url()));
page.on('pageerror', error => errors.push(error.message));
try {
  if (native) await page.getByRole('link', { name: '本地知识库', exact: true }).click();
  else await page.goto('http://127.0.0.1:1423/local-knowledge');
  await expect(page.getByRole('button', { name: '启用模型 / 按配置重建' })).toBeEnabled();
  // A deterministic index fixture; this test verifies backup plumbing, not embedding quality.
  await page.evaluate(async () => {
    const profile = { repo: 'Xenova/multilingual-e5-small', revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
      sha256: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193', dtype: 'q8', dimensions: 384,
      maxTokens: 512, pooling: 'mean', normalize: true, queryPrefix: 'query: ', passagePrefix: 'passage: ' };
    const text = '员工报销需提交发票。';
    const index = { version: 1, revision: 'backup-qa', profile,
      fingerprint: JSON.stringify({ runtime: 'transformers-3.8.1-wasm', chunker: 'unicode-contiguous-v1', ...profile }),
      updatedAt: new Date().toISOString(), documents: [{ id: 'd1', name: '报销.md', text, bytes: new TextEncoder().encode(text).length }],
      chunks: [{ documentId: 'd1', start: 0, end: text.length, text, vector: Array.from({ length: 384 }, (_, i) => i === 0 ? 1 : 0) }] };
    await new Promise((resolve, reject) => { const r = indexedDB.open('geiit-local-knowledge-v1', 1); r.onerror = reject; r.onsuccess = () => {
      const db = r.result, tx = db.transaction('index', 'readwrite'); tx.objectStore('index').put(index, 'active');
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = reject;
    }; });
  });
  await page.reload();
  const section = page.getByRole('region', { name: '本地知识库备份与恢复' });
  await section.getByLabel('备份口令', { exact: true }).fill('fixture-only-password');
  await section.getByLabel('确认备份口令（仅导出）').fill('fixture-only-password');
  const downloaded = page.waitForEvent('download');
  await section.getByRole('button', { name: '导出加密备份' }).click();
  const download = await downloaded, backupFile = path.join(output, 'fixture.geiitkb');
  await download.saveAs(backupFile);
  const bytes = await readFile(backupFile);
  expect(bytes.toString()).not.toContain('员工报销');
  expect(await section.getByLabel('备份口令', { exact: true }).inputValue()).toBe('');
  await section.getByLabel('备份口令', { exact: true }).fill('wrong-password');
  await section.getByLabel('选择知识库备份').setInputFiles(backupFile);
  await expect(section.getByRole('alert')).toContainText('口令不正确');
  await expect(page.getByRole('button', { name: '删除 报销.md' })).toBeVisible();
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '删除全部本地文档' }).click();
  await expect(page.getByText('尚未添加文档')).toBeVisible();
  await section.getByLabel('备份口令', { exact: true }).fill('fixture-only-password');
  await section.getByLabel('选择知识库备份').setInputFiles(backupFile);
  await expect(section.getByText('待恢复：1 个文件 · 1 个片段')).toBeVisible();
  await expect(page.getByText('尚未添加文档')).toBeVisible();
  await section.getByRole('button', { name: '取消恢复' }).click();
  await expect(page.getByText('尚未添加文档')).toBeVisible();
  await section.getByLabel('备份口令', { exact: true }).fill('fixture-only-password');
  await section.getByLabel('选择知识库备份').setInputFiles(backupFile);
  await section.getByRole('button', { name: '确认替换本地库' }).click();
  await expect(page.getByRole('button', { name: '删除 报销.md' })).toBeVisible();
  await expect(page.getByRole('button', { name: '选择文件并建立索引' })).toBeDisabled();
  // A change in a second tab after preflight must prevent replacement.
  await section.getByLabel('备份口令', { exact: true }).fill('fixture-only-password');
  await section.getByLabel('选择知识库备份').setInputFiles(backupFile);
  await expect(section.getByRole('button', { name: '确认替换本地库' })).toBeVisible();
  await page.evaluate(async () => new Promise(resolve => {
    const r = indexedDB.open('geiit-local-knowledge-v1', 1); r.onsuccess = () => {
      const db = r.result, tx = db.transaction('index', 'readwrite'), store = tx.objectStore('index'), request = store.get('active');
      request.onsuccess = () => store.put({ ...request.result, revision: 'modified-elsewhere' }, 'active');
      tx.oncomplete = () => { db.close(); resolve(); };
    };
  }));
  await section.getByRole('button', { name: '确认替换本地库' }).click();
  await expect(section.getByRole('alert')).toContainText('另一个窗口');
  await section.getByRole('button', { name: '取消恢复' }).click();
  await page.screenshot({ path: path.join(output, native ? 'backup-native.png' : 'backup-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, 'backup-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(requests.filter(url => /huggingface|embedding.worker|\.wasm|\/api\/v1\//.test(url))).toEqual([]);
  expect(errors).toEqual([]);
  await writeFile(path.join(output, native ? 'native-result.json' : 'result.json'), JSON.stringify({ passed: true, native, encryptedBytes: bytes.length, scope: 'Real WebCrypto, IndexedDB, file download/import; fixture vectors; no model/network inference.' }, null, 2));
  console.log('Encrypted export, wrong password, preflight, cancel, restore, stale revision, opt-in isolation and desktop/mobile checks passed.');
} finally { await browser.close(); app?.kill(); }
