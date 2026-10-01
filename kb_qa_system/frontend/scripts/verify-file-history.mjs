import { readVaultCiphertext } from './vault-qa.mjs';
// Isolated encrypted synthetic histories in the production Web / dev executable.
// This checks history navigation, lazy DOM and actual exports; it grants no directory access.
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const native = process.argv.includes('--native'), mode = native ? 'native' : 'web';
const output = path.resolve('../../.tools/file-history-qa', mode); await mkdir(output, { recursive: true });
const run = await mkdtemp(path.join(output, 'run-')), password = 'synthetic-history-test', storageKey = 'geiit.workbench.encrypted.v1';
const stamp = i => new Date(Date.UTC(2026, 8, 29, 0, i)).toISOString();
const snapshot = text => ({ text, sha256: createHash('sha256').update(text).digest('hex') });
const before = snapshot('原始内容🙂\r\n' + 'a'.repeat(8192)), after = snapshot('修改内容🙂\r\n' + 'b'.repeat(8192));
const versions = Array.from({ length: 50 }, (_, i) => ({
  id: 'version-' + String(i).padStart(2, '0'), draftId: 'draft-' + i, name: `文件-${i}.md`, directoryName: '合成文本目录',
  before, after, status: i === 1 ? 'not-started' : 'succeeded', createdAt: stamp(Math.floor(i / 2)), updatedAt: stamp(50), batch: { id: 'batch-' + String(Math.floor(i / 2)).padStart(2, '0'), index: i % 2, total: 2 },
}));
const organizers = Array.from({ length: 100 }, (_, i) => ({
  id: 'run-' + String(i).padStart(3, '0'), directoryName: '合成整理目录', kind: 'rename', status: 'succeeded', createdAt: stamp(i), updatedAt: stamp(i),
  changes: Array.from({ length: i === 0 ? 500 : 1 }, (_, j) => ({ source: `source-${i}-${j}.md`, target: `target-${i}-${j}.md`, stage: `.geiit-stage-${i}-${j}`, size: 3, sha256: createHash('sha256').update('new').digest('hex') })),
}));
const fixture = { profiles: [], conversations: [], taskRuns: [], toolRuns: [], artifacts: [], organizerRuns: organizers, fileEditVersions: versions };
function encrypt(data) {
  const salt = randomBytes(16), iv = randomBytes(12), key = pbkdf2Sync(password, salt, 600000, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from('geiit-private-workbench-v1'));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({ version: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), ciphertext: bytes.toString('base64') });
}
function decrypt(encoded) {
  const e = JSON.parse(encoded), bytes = Buffer.from(e.ciphertext, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', pbkdf2Sync(password, Buffer.from(e.salt, 'base64'), 600000, 32, 'sha256'), Buffer.from(e.iv, 'base64'));
  decipher.setAAD(Buffer.from('geiit-private-workbench-v1')); decipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString());
}
const encrypted = encrypt(fixture), errors = [];
const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
let app, browser, page, launchError;
try {
  if (native) {
    app = spawn(path.resolve('src-tauri/target-dev/release/geiit-workbench.exe'), [], { windowsHide: true, stdio: 'ignore', env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: path.join(run, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port } });
    app.on('error', error => { launchError = error; });
    for (let i = 0; i < 60; i++) {
      if (launchError) throw launchError; if (app.exitCode !== null) throw new Error('Native app exited');
      try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 700 }); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 200)); }
    }
    if (!browser) throw new Error('Native debugger unavailable');
    const context = browser.contexts()[0]; page = context.pages()[0] || await context.waitForEvent('page');
  } else {
    app = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--configLoader', 'runner', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { windowsHide: true, stdio: 'ignore' });
    app.on('error', error => { launchError = error; }); const url = 'http://127.0.0.1:' + port + '/workbench';
    await expect.poll(async () => { if (launchError) throw launchError; try { return (await fetch(url)).ok; } catch { return false; } }, { timeout: 15000 }).toBe(true);
    browser = await chromium.launch({ headless: true }); page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1280, height: 900 } }); await page.goto(url);
  }
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  await expect(page.getByRole('heading', { name: '创建本机密钥库', exact: true })).toBeVisible();
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [storageKey, encrypted]); await page.reload();
  const button = name => page.getByRole('button', { name, exact: true });
  const region = name => page.getByRole('region', { name, exact: true });
  const pager = (label, name) => page.getByRole('navigation', { name: label + '分页', exact: true }).getByRole('button', { name, exact: true });
  const stored = () => readVaultCiphertext(page, storageKey);
  async function unlock() { await page.getByLabel('解锁口令', { exact: true }).fill(password); await button('解锁').click(); await button('文件整理').click(); }
  async function exported(target, name) {
    const event = page.waitForEvent('download'); await target.click(); const file = await event; const filename = path.join(run, name); await file.saveAs(filename); return readFile(filename, 'utf8');
  }
  await unlock();
  const organizer = region('整理历史'); await expect(organizer.locator('summary')).toHaveCount(10); await expect(organizer.locator('li')).toHaveCount(0);
  await pager('整理历史', '末页').click(); await expect(organizer).toContainText('第 10/10 页');
  await page.getByLabel('整理历史搜索').fill('target-0-499'); await expect(organizer.locator('summary')).toHaveCount(1); await expect(organizer).toContainText('第 1/1 页');
  await organizer.locator('summary').click(); await expect(organizer.locator('li')).toHaveCount(50);
  await button('下一组文件').click(); await expect(organizer.locator('li').first()).toContainText('source-0-50.md');
  const downloadedRun = JSON.parse(await exported(button('导出记录'), 'organizer.json')); expect(downloadedRun.id).toBe('run-000'); expect(downloadedRun.changes).toHaveLength(500);
  await page.screenshot({ path: path.join(run, 'organizer.png') });
  await page.getByRole('tab', { name: '文本内容编辑', exact: true }).click(); const text = region('文本版本历史');
  await expect(text.locator('summary')).toHaveCount(10); await pager('文本历史', '末页').click(); await expect(text).toContainText('第 5/5 页');
  await page.getByLabel('文本历史搜索').fill('version-00'); await expect(text.locator('summary')).toHaveCount(1); await text.locator('summary').click();
  const downloadedBefore = await exported(button('导出历史原文（明文）'), 'original.md'); expect(downloadedBefore).toBe(before.text);
  await page.getByLabel('文本历史状态').selectOption('not-started'); await expect(text.locator('summary')).toHaveCount(0); await expect(text).toContainText('没有符合条件');
  await button('清除筛选').click(); await expect(text).toContainText('第 1/5 页');
  await page.getByRole('tab', { name: '批量文本编辑', exact: true }).click(); const batches = region('批量文本历史');
  await expect(batches.locator('summary')).toHaveCount(10); await pager('批次历史', '末页').click(); await expect(batches.locator('summary')).toHaveCount(5);
  await page.getByLabel('批次历史搜索').fill('文件-1.md'); await page.getByLabel('批次历史状态').selectOption('not-started');
  await expect(batches.locator('summary')).toHaveCount(1); await expect(batches.locator('summary')).toContainText('2/2 条'); await batches.locator('summary').click();
  await expect(batches).toContainText('文件-0.md'); const downloadedBatch = JSON.parse(await exported(button('导出批次记录（明文）'), 'batch.json'));
  expect(downloadedBatch.records.map(r => r.id)).toEqual(['version-00', 'version-01']); expect(await stored()).toBe(encrypted);
  if (!native) {
    await page.setViewportSize({ width: 390, height: 844 }); await page.getByLabel('批次历史搜索').scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: path.join(run, 'mobile.png') }); await page.setViewportSize({ width: 1280, height: 900 });
  }
  // Only an explicit delete mutates the vault. A filtered batch export above must
  // never delete or narrow its hidden members. Deletion is persisted and decoded independently.
  await page.getByRole('tab', { name: '文本内容编辑', exact: true }).click(); await pager('文本历史', '末页').click();
  await page.getByLabel('文本历史搜索').fill('version-00'); await text.locator('summary').click(); await button('删除文本记录').click();
  await expect(text.locator('summary')).toHaveCount(0);
  await expect.poll(async () => decrypt(await stored()).fileEditVersions.length).toBe(49);
  const saved = decrypt(await stored()); expect(saved.fileEditVersions.some(r => r.id === 'version-00')).toBe(false); expect(saved.fileEditVersions.some(r => r.id === 'version-01')).toBe(true); expect(saved.organizerRuns).toEqual(organizers);
  await page.reload(); await unlock(); await page.getByRole('tab', { name: '批量文本编辑', exact: true }).click(); await page.getByLabel('批次历史搜索').fill('batch-00');
  await expect(batches.locator('summary')).toHaveCount(1); await expect(batches.locator('summary')).toContainText('1/2 条');
  await page.screenshot({ path: path.join(run, 'partial-history.png') }); expect(errors).toEqual([]);
  const result = { passed: true, mode, fixture: { organizerRecords: 100, textVersions: 50, batches: 25, largestFileList: 500, encryptedBytes: Buffer.byteLength(encrypted) }, checks: ['bounded 10-record pages and lazy closed details', '50-file detail pages with full 500-file JSON export', 'search beyond current page and filter reset', 'exact old text export from later history page', 'same-member status and query matching with complete batch export', 'read-only navigation preserves ciphertext', 'explicit delete preserves other histories and partial batch after refresh', ...(!native ? ['390px no horizontal overflow'] : [])], pageErrors: errors };
  await writeFile(path.join(run, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ run, ...result }));
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(run, 'failure.png') }).catch(() => {}); await writeFile(path.join(run, 'failure.txt'), String(error)); }
  throw error;
} finally { await browser?.close(); app?.kill(); }
