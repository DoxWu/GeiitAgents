// Synthetic production-browser capacity / process interruption checks.
// This is not a low-memory device, WebView2, or physical power-loss test.
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readVaultCiphertext, writeVaultCiphertext, removeVaultCiphertext } from './vault-qa.mjs';

const output = path.resolve(process.env.VAULT_CAPACITY_QA_OUTPUT_DIR || '../../.tools/vault-capacity-qa');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(output, 'chromium-'));
const password = 'synthetic-capacity-1234', key = 'geiit.workbench.encrypted.v1';
const now = new Date().toISOString();
function seal(data) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', pbkdf2Sync(password, salt, 600000, 32, 'sha256'), iv);
  cipher.setAAD(Buffer.from('geiit-private-workbench-v1'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({ version: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64') });
}
function unseal(text, pass = password, backup = false) {
  const envelope = JSON.parse(text), bytes = Buffer.from(envelope.ciphertext, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', pbkdf2Sync(pass, Buffer.from(envelope.salt, 'base64'), 600000, 32, 'sha256'), Buffer.from(envelope.iv, 'base64'));
  cipher.setAAD(Buffer.from(backup ? 'geiit-workbench-backup:1' : 'geiit-private-workbench-v1')); cipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(0, -16)), cipher.final()]).toString('utf8'));
}
async function unusedPort() {
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); return port;
}
let preview, processBrowser, browser, context, page;
let browserDiagnostics = '';
const errors = [], timings = {};
async function launch() {
  const port = await unusedPort();
  processBrowser = spawn(chromium.executablePath(), ['--headless', '--no-sandbox', '--disable-gpu', '--enable-automation', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  processBrowser.stderr.on('data', chunk => { browserDiagnostics = (browserDiagnostics + chunk.toString()).slice(-8000); });
  let launchError; processBrowser.on('error', error => { launchError = error; });
  await expect.poll(async () => {
    if (launchError) throw launchError;
    if (processBrowser.exitCode !== null) throw new Error('Isolated Chromium exited');
    try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; }
  }, { timeout: 15000 }).toBe(true);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); context = browser.contexts()[0];
  await context.route('**/api/v1/**', route => route.fulfill({ json: {} }));
  await context.routeWebSocket('**/ws/notifications', () => {});
  page = context.pages()[0] || await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  page.on('pageerror', error => errors.push(error.message));
}
async function forceClose() {
  const child = processBrowser, exited = new Promise(resolve => child.once('exit', resolve));
  expect(child.kill('SIGKILL')).toBe(true); await exited;
  browser = null; processBrowser = null;
}
const button = name => page.getByRole('button', { name, exact: true });
async function unlock() {
  const started = performance.now();
  await page.getByLabel('解锁口令', { exact: true }).fill(password); await button('解锁').click();
  await expect(page.getByText('本机密钥库已解锁', { exact: true })).toBeVisible({ timeout: 30000 });
  await button('笔记与待办').click(); await expect(page.getByRole('region', { name: '笔记与待办' })).toBeVisible();
  return Math.round(performance.now() - started);
}
try {
  const port = await unusedPort(), url = `http://127.0.0.1:${port}/workbench`;
  preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort', '--configLoader', 'runner'], { windowsHide: true, stdio: 'ignore' });
  await expect.poll(async () => { try { return (await fetch(url)).ok; } catch { return false; } }, { timeout: 15000 }).toBe(true);
  await launch(); await page.goto(url);

  // Verify a real legacy ciphertext is accepted and migrated on the next UI save.
  const legacyItem = { id: randomUUID(), revision: 1, kind: 'note', title: '旧库迁移记录', content: 'legacy-only', tags: [], createdAt: now, updatedAt: now, completedAt: null };
  const legacy = seal({ profiles: [], conversations: [], personalItems: [legacyItem] });
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [key, legacy]); await page.reload(); await unlock();
  await button('笔记').click(); await button('旧库迁移记录').click(); await page.getByLabel('标题', { exact: true }).fill('旧库已迁移');
  await button('保存记录').click(); await expect(page.getByRole('status')).toHaveText('已保存到本机加密库。');
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toMatch(/^geiit-indexeddb-v1:/);
  expect(unseal(await readVaultCiphertext(page)).personalItems[0].title).toBe('旧库已迁移');
  await button('锁定本机密钥库').click(); await removeVaultCiphertext(page);

  // Both collection counts and every content length reach their documented limits.
  const items = Array.from({ length: 500 }, (_, index) => ({ ...legacyItem, id: randomUUID(), title: `容量记录 ${String(index).padStart(3, '0')}`, content: `${index}:` + 'x'.repeat(20000 - String(index).length - 1) }));
  const drafts = Array.from({ length: 100 }, (_, index) => ({ id: index === 0 ? items[0].id : randomUUID(), editId: randomUUID(), baseRevision: index === 0 ? 1 : 0,
    input: { kind: 'note', title: `容量草稿 ${index}`, content: 'd'.repeat(20000), tags: [] }, tagsText: '', dueText: '', timezone: 'Asia/Shanghai', updatedAt: now }));
  const fixture = { profiles: [], conversations: [], personalItems: items, personalDrafts: drafts };
  const plaintextBytes = Buffer.byteLength(JSON.stringify(fixture)), ciphertext = seal(fixture);
  await writeVaultCiphertext(page, ciphertext); await page.reload(); timings.unlockMs = await unlock();
  await button('笔记').click(); await button('容量记录 000').click();
  await expect(page.getByLabel('笔记或待办内容')).toHaveValue('d'.repeat(20000));
  const saveStarted = performance.now(); await page.getByLabel('标题', { exact: true }).fill('容量已保存');
  await button('保存记录').click(); await expect(page.getByRole('status')).toHaveText('已保存到本机加密库。', { timeout: 30000 });
  timings.saveMs = Math.round(performance.now() - saveStarted);
  const committed = await readVaultCiphertext(page), committedData = unseal(committed);
  expect(committed.length).toBeGreaterThan(6 * 1024 * 1024); expect(committed).not.toContain('容量已保存');
  expect(committedData.personalItems).toHaveLength(500); expect(committedData.personalDrafts).toHaveLength(99);
  await button('工作台备份').click(); await page.getByLabel('备份口令', { exact: true }).fill('synthetic-backup-1234');
  await page.getByLabel('确认备份口令', { exact: true }).fill('synthetic-backup-1234');
  const backupStarted = performance.now(), downloadEvent = page.waitForEvent('download'); await button('下载加密工作台备份').click();
  const download = await downloadEvent, backupFile = path.join(output, 'capacity.geiitwork'); await download.saveAs(backupFile);
  timings.backupMs = Math.round(performance.now() - backupStarted);
  const backup = await readFile(backupFile, 'utf8'); expect(unseal(backup, 'synthetic-backup-1234', true).data).toEqual(committedData);
  const cdp = await context.newCDPSession(page), heap = (await cdp.send('Runtime.getHeapUsage')).usedSize;

  // Kill only the spawned browser main process while a genuine IDB write
  // transaction is deliberately kept uncommitted by a request chain.
  await page.evaluate(({ key, value }) => new Promise((resolve, reject) => {
    const request = indexedDB.open('geiit-private-vault-v1', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const tx = request.result.transaction('vaults', 'readwrite'), store = tx.objectStore('vaults');
      store.put({ key, value: value + ' ' });
      const keepAlive = () => { store.get(key).onsuccess = keepAlive; }; keepAlive();
      window.__qaUncommittedTx = tx; resolve();
    };
  }), { key, value: committed });
  await forceClose(); await launch(); await page.goto(url);
  expect(await readVaultCiphertext(page)).toBe(committed); timings.restartUnlockMs = await unlock();
  await button('笔记').click(); await button('容量已保存').click(); await expect(page.getByLabel('笔记或待办内容')).toHaveValue('d'.repeat(20000));
  expect(errors).toEqual([]);
  const result = { passed: true, personalItems: 500, personalDraftsBeforeSave: 100, contentCharactersEach: 20000, plaintextBytes, ciphertextCharacters: committed.length,
    backupBytes: Buffer.byteLength(backup), timings, sampledJsHeapBytes: heap, checks: ['legacy UI migration', 'maximum record/draft counts and content length', 'save and exact independent decryption', 'actual encrypted backup download', 'uncommitted transaction discarded after forced browser process termination', 'previous committed notes recover after restart'],
    limits: ['development machine, not 8 GB or memory-constrained', 'Chromium main process termination, not physical power loss or Windows WebView2', 'no timing or memory SLA', 'whole-vault encryption remains', 'synthetic data only; no real API calls or emails'] };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ message: String(error), errors, browserDiagnostics }, null, 2)); throw error;
} finally { await browser?.close(); processBrowser?.kill(); preview?.kill(); }
