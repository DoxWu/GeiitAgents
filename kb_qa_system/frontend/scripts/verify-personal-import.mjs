// Synthetic browser / packaged WebView2 checks. No real provider or email calls.
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { randomUUID, webcrypto } from 'node:crypto';
import path from 'node:path';
import { readVaultCiphertext, setVaultWriteFailure } from './vault-qa.mjs';

const native = process.argv.includes('--native'), output = path.resolve('../../.tools/personal-import-qa', native ? 'native' : 'web');
await mkdir(output, { recursive: true });
async function unusedPort() {
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); return port;
}
let app, browser, context, page;
const errors = [], requests = [], password = 'personal-import-test-1234', now = '2026-09-29T10:00:00.000Z';
try {
  const port = await unusedPort();
  if (native) {
    const profile = await mkdtemp(path.join(output, 'webview-'));
    app = spawn(path.resolve('src-tauri/target-dev/release/geiit-workbench.exe'), [], { windowsHide: true, stdio: 'ignore', env: {
      ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port,
    } });
    let launchError; app.on('error', error => { launchError = error; });
    for (let attempt = 0; attempt < 60; attempt++) {
      if (launchError) throw launchError; if (app.exitCode !== null) throw new Error('Native app exited');
      try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 700 }); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 200)); }
    }
    if (!browser) throw new Error('Native debugger unavailable');
    context = browser.contexts()[0]; page = context.pages()[0] || await context.waitForEvent('page');
  } else {
    app = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort', '--configLoader', 'runner'], { windowsHide: true, stdio: 'ignore' });
    let launchError; app.on('error', error => { launchError = error; });
    const url = `http://127.0.0.1:${port}/workbench`;
    await expect.poll(async () => { if (launchError) throw launchError; try { return (await fetch(url)).ok; } catch { return false; } }, { timeout: 15000 }).toBe(true);
    browser = await chromium.launch({ headless: true }); context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
    page = await context.newPage(); await page.goto(url);
  }
  page.on('pageerror', error => errors.push(error.message)); context.on('request', request => requests.push(request.url()));
  await context.route('**/api/v1/**', route => route.fulfill({ json: {} })); await context.routeWebSocket('**/ws/notifications', () => {});
  const button = name => page.getByRole('button', { name, exact: true });
  async function unlock(create = false) {
    await page.getByLabel('解锁口令', { exact: true }).fill(password);
    if (create) await page.getByLabel('确认口令', { exact: true }).fill(password);
    await button(create ? '创建' : '解锁').click(); await button('笔记与待办').click();
    await expect(page.getByRole('region', { name: '笔记与待办' })).toBeVisible();
  }
  async function upload(value, name = 'records.json') {
    await page.getByLabel('笔记待办导入文件').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)) });
    await expect(page.getByRole('region', { name: '笔记待办导入预检查' })).toBeVisible();
  }
  async function commit(saved = true) {
    await page.getByLabel('我已核对所选条目及替换内容，确认写入本机加密库').check(); await button('确认导入所选条目').click();
    await expect(page.getByText(saved ? '导入已加密保存' : '导入结果已在内存，尚未确认持久保存', { exact: true })).toBeVisible();
  }
  async function download(name, filename) {
    const event = page.waitForEvent('download'); await button(name).click(); const file = await event;
    await file.saveAs(path.join(output, filename)); return readFile(path.join(output, filename), 'utf8');
  }
  async function savedData() {
    const encoded = await readVaultCiphertext(page);
    expect(encoded).not.toContain('导入'); const envelope = JSON.parse(encoded);
    const material = await webcrypto.subtle.importKey('raw', Buffer.from(password), 'PBKDF2', false, ['deriveKey']);
    const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', salt: Buffer.from(envelope.salt, 'base64'), iterations: 600000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const plain = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(envelope.iv, 'base64'), additionalData: Buffer.from('geiit-private-workbench-v1') }, key, Buffer.from(envelope.ciphertext, 'base64'));
    return JSON.parse(Buffer.from(plain).toString());
  }
  await unlock(true); const apiBefore = requests.filter(url => url.includes('/api/')).length;
  await button('笔记').click(); await page.getByLabel('标题', { exact: true }).fill('导入原始笔记');
  await page.getByLabel('笔记或待办内容').fill('导入测试正文\n<script>alert(1)</script>\n![x](https://example.test/never.png)');
  await button('保存记录').click(); await expect(page.getByRole('status')).toHaveText('已保存到本机加密库。');
  await page.getByLabel('选择记录：导入原始笔记').check(); const actualExport = await download('批量导出 JSON', 'actual-export.json'), exported = JSON.parse(actualExport);
  page.once('dialog', dialog => dialog.accept()); await button('删除记录').click(); await expect(page.getByRole('status')).toHaveText('已删除。');
  await button('导入 JSON').click(); await upload(actualExport); await expect(button('确认导入所选条目')).toBeDisabled();
  await page.getByText('比较文件内容与本机内容', { exact: true }).click();
  expect(await page.locator('section[aria-label="笔记待办导入预检查"] script').count()).toBe(0);
  await commit(); expect((await savedData()).personalItems).toEqual(exported.items);
  await upload(actualExport); await expect(page.getByLabel('导入处理方式 1', { exact: true })).toHaveValue('skip');
  await page.getByLabel('导入处理方式 1', { exact: true }).selectOption('copy'); await commit();
  let saved = await savedData(); expect(saved.personalItems).toHaveLength(2); expect(new Set(saved.personalItems.map(i => i.id)).size).toBe(2);
  const changed = structuredClone(exported); changed.items[0].content = '文件替换正文';
  await upload(changed); await page.getByLabel('导入处理方式 1', { exact: true }).selectOption('replace');
  await setVaultWriteFailure(page, true);
  await commit(false); await expect(button('重试保存导入结果')).toBeEnabled(); await expect(page.getByLabel('笔记待办导入文件')).toBeDisabled();
  expect((await savedData()).personalItems.find(i => i.id === exported.items[0].id).content).toBe(exported.items[0].content);
  await setVaultWriteFailure(page, false); await button('重试保存导入结果').click(); await expect(page.getByText('导入已加密保存', { exact: true })).toBeVisible();
  saved = await savedData(); expect(saved.personalItems).toHaveLength(2); expect(saved.personalItems.find(i => i.id === exported.items[0].id)).toMatchObject({ revision: 2, content: '文件替换正文' });
  const merged = structuredClone(exported); merged.items[0].title = '字段合并标题'; merged.items[0].content = '字段合并正文'; merged.items[0].tags = ['文件标签'];
  await upload(merged); await page.getByLabel('导入处理方式 1', { exact: true }).selectOption('merge');
  await expect(button('确认导入所选条目')).toBeDisabled(); await page.getByLabel('采用文件中的标题', { exact: true }).check(); await commit();
  saved = await savedData(); expect(saved.personalItems.find(i => i.id === exported.items[0].id)).toMatchObject({ revision: 3, title: '字段合并标题', content: '文件替换正文', tags: exported.items[0].tags });
  await page.reload(); await unlock(); await button('笔记').click(); await button('导入 JSON').click();
  const draft = { id: randomUUID(), editId: randomUUID(), baseRevision: 0, input: { kind: 'todo', title: '导入未完成草稿', content: '原始内容', tags: [], status: 'open', priority: 'high', dueAt: null }, tagsText: '原始，原始，', dueText: 'unfinished', timezone: 'Asia/Shanghai', updatedAt: now };
  await upload(draft, 'draft.json'); await page.getByText('比较文件内容与本机内容', { exact: true }).click();
  await expect(page.getByText(/原始截止输入：unfinished/)).toBeVisible(); await commit();
  saved = await savedData(); expect(saved.personalDrafts).toHaveLength(1); expect(saved.personalDrafts[0]).toMatchObject({ baseRevision: 0, dueText: 'unfinished', timezone: 'Asia/Shanghai', tagsText: draft.tagsText }); expect(saved.personalDrafts[0].id).not.toBe(draft.id);
  await page.reload(); await unlock(); await expect(page.getByLabel('标题', { exact: true })).toHaveValue(draft.input.title);
  const actualDraft = JSON.parse(await download('导出当前草稿', 'actual-draft.json')); expect(actualDraft.dueText).toBe('unfinished');
  await button('导入 JSON').click(); await upload(actualDraft, 'actual-draft.json'); await expect(page.getByLabel('导入处理方式 1', { exact: true })).toHaveValue('skip'); await button('取消导入预检查').click();
  const batch = { format: 'geiit.personal-records', version: 1, exportedAt: now, items: Array.from({ length: 21 }, (_, i) => ({ ...exported.items[0], id: randomUUID(), title: '分页笔记 ' + i, content: 'local only ' + i })) };
  await upload(batch); await page.getByLabel('导入处理方式 1', { exact: true }).selectOption('skip'); await button('下一页导入条目').click(); await page.getByLabel('导入处理方式 21').selectOption('skip'); await button('上一页导入条目').click(); await expect(page.getByLabel('导入处理方式 1', { exact: true })).toHaveValue('skip');
  await page.screenshot({ path: path.join(output, 'desktop.png') });
  if (!native) { await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(output, 'mobile.png') }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.setViewportSize({ width: 1280, height: 900 }); }
  await commit(); saved = await savedData(); expect(saved.personalItems).toHaveLength(21); expect(saved).not.toHaveProperty('personalImportPreview'); expect(saved).not.toHaveProperty('personalImportResult');
  await page.reload(); await unlock(); expect((await savedData()).personalItems).toHaveLength(21);
  expect(requests.filter(url => url.includes('/api/')).length).toBe(apiBefore); expect(requests.some(url => url.includes('example.test'))).toBe(false); expect(errors).toEqual([]);
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, native, checks: ['actual export/delete/import', 'confirmation gate and inert source text', 'duplicate skip/copy', 'replacement quota failure and persist-only retry', 'selected-field merge retains local fields', 'independent persisted decryption', 'raw draft import/refresh/export roundtrip', 'pagination selection retention', 'ephemeral previews excluded from vault', ...(native ? [] : ['390px layout']), 'zero additional API/model requests'], emailsSent: 0 }, null, 2));
  console.log(`Personal import ${native ? 'native' : 'browser'} verification passed. Output: ${output}`);
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ message: String(error), errors }, null, 2)); throw error;
} finally { await browser?.close(); app?.kill(); }
