// Packaged Windows WebView2, synthetic profiles, and exact spawned process trees.
// Never installs an app or opens an existing profile. Not a power-loss/8 GB test.
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readVaultCiphertext, writeVaultCiphertext } from './vault-qa.mjs';

const { values } = parseArgs({ options: { exe: { type: 'string' }, output: { type: 'string' } } });
if (process.platform !== 'win32') throw new Error('Windows required.');
const executable = path.resolve(values.exe ?? 'src-tauri/target-dev/release/geiit-workbench.exe');
const output = path.resolve(values.output ?? '../../.tools/native-vault-recovery-qa');
await mkdir(output, { recursive: true });
const run = await mkdtemp(path.join(output, 'run-')), profile = path.join(run, 'webview');
await mkdir(profile);
const binary = await readFile(executable);
const password = 'synthetic-native-recovery-pass', backupPassword = 'synthetic-native-backup-pass';
const vaultKey = 'geiit.workbench.encrypted.v1';
const errors = [], externalAttempts = [], stages = [], checks = [], timings = {};
let active;
function seal(data) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', pbkdf2Sync(password, salt, 600000, 32, 'sha256'), iv);
  cipher.setAAD(Buffer.from('geiit-private-workbench-v1'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({ version: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64') });
}
function decrypt(text, secret = password, backup = false) {
  const envelope = JSON.parse(text), bytes = Buffer.from(envelope.ciphertext, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', pbkdf2Sync(secret, Buffer.from(envelope.salt, 'base64'), 600000, 32, 'sha256'), Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(Buffer.from(backup ? 'geiit-workbench-backup:1' : 'geiit-private-workbench-v1'));
  decipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString('utf8'));
}
async function port() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const result = server.address().port; await new Promise(resolve => server.close(resolve)); return result;
}
async function command(file, args) {
  const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = ''; child.stdout.on('data', chunk => { text += chunk; }); child.stderr.on('data', chunk => { text += chunk; });
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error(`${file} exited ${code}: ${text.slice(-1500)}`);
  return text;
}
async function launch(stage) {
  const debugPort = await port();
  const app = spawn(executable, [], { windowsHide: true, stdio: 'ignore', env: {
    ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${debugPort}`,
  } });
  const handle = { app, stage, debugPort, browser: null, page: null, launchError: null, exit: null };
  active = handle;
  app.on('error', error => { handle.launchError = error; });
  handle.exit = once(app, 'exit').catch(() => {});
  await expect.poll(async () => {
    if (handle.launchError) throw handle.launchError;
    if (app.exitCode !== null) throw new Error(`Native app exited at ${stage}`);
    try { handle.browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, { timeout: 500 }); return true; }
    catch { return false; }
  }, { timeout: 30000 }).toBe(true);
  const context = handle.browser.contexts()[0];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/v1/')) return route.fulfill({ json: {} });
    if (/^https?:$/.test(url.protocol) && !['tauri.localhost', 'localhost', '127.0.0.1'].includes(url.hostname)) {
      externalAttempts.push({ stage, origin: url.origin }); return route.abort();
    }
    return route.continue();
  });
  await context.routeWebSocket('**/ws/notifications', () => {});
  handle.page = context.pages()[0] ?? await context.waitForEvent('page');
  handle.page.on('pageerror', error => errors.push({ stage, message: error.message }));
  handle.page.on('dialog', dialog => dialog.dismiss());
  stages.push({ stage, pid: app.pid, webview: handle.browser.version(), origin: new URL(handle.page.url()).origin });
  console.log(`Native vault stage: ${stage}`);
  return handle.page;
}
async function waitForExit(handle) {
  let timer;
  try { await Promise.race([handle.exit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Spawned app did not exit')), 10000); })]); }
  finally { clearTimeout(timer); }
}
async function forceTree() {
  const handle = active;
  if (!handle?.app.pid || handle.app.exitCode !== null) throw new Error('Expected a live spawned native app.');
  // Enumerate only descendants of this script's live host. No name/global kill.
  const tree = JSON.parse(await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$rows = @(Get-CimInstance Win32_Process); $pending = @(${handle.app.pid}); $found = @(); while ($pending.Count -gt 0) { $next = @(); foreach ($id in $pending) { $row = $rows | Where-Object { $_.ProcessId -eq $id }; if ($row) { $found += $row | Select-Object ProcessId,ParentProcessId,Name; $next += @($rows | Where-Object { $_.ParentProcessId -eq $id } | ForEach-Object { $_.ProcessId }) } }; $pending = $next }; ConvertTo-Json -InputObject @($found) -Compress`,
  ]));
  expect(tree.some(item => item.ProcessId === handle.app.pid && item.Name === path.basename(executable))).toBe(true);
  expect(tree.some(item => item.Name === 'msedgewebview2.exe')).toBe(true);
  await command('taskkill.exe', ['/PID', String(handle.app.pid), '/T', '/F']);
  await waitForExit(handle);
  const ids = tree.map(item => item.ProcessId);
  await expect.poll(async () => Number((await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `@(Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue).Count`,
  ])).trim()), { timeout: 15000 }).toBe(0);
  stages.at(-1).forcedProcessTree = tree;
  await expect.poll(async () => { try { await fetch(`http://127.0.0.1:${handle.debugPort}/json/version`); return false; } catch { return true; } }, { timeout: 10000 }).toBe(true);
  await handle.browser.close().catch(() => {}); active = null;
}
async function close() {
  const handle = active; if (!handle) return;
  await handle.browser?.close().catch(() => {});
  if (handle.app.exitCode === null) handle.app.kill();
  await waitForExit(handle); active = null;
}
const button = (page, name) => page.getByRole('button', { name, exact: true });
const field = (page, name) => page.getByLabel(name, { exact: true });
async function unlock(page, create = false) {
  await field(page, '解锁口令').fill(password);
  if (create) await field(page, '确认口令').fill(password);
  await button(page, create ? '创建' : '解锁').click();
  await expect(page.getByText('本机密钥库已解锁', { exact: true })).toBeVisible({ timeout: 30000 });
  await button(page, '笔记与待办').click(); await button(page, '笔记').click();
}
async function rawDraft(page, body) {
  await field(page, '笔记或待办内容').fill(body);
  await expect(page.getByText('草稿已加密保存，切换记录、刷新或锁库后可继续。', { exact: true })).toBeVisible({ timeout: 30000 });
  return decrypt(await readVaultCiphertext(page));
}
async function faultOnFinalWrite(page, mode) {
  await page.evaluate(({ vaultKey, mode }) => {
    const original = IDBObjectStore.prototype.put;
    window.__qaFault = { mode, writes: 0, keptAlive: 0, pending: false, completed: false, candidate: null };
    IDBObjectStore.prototype.put = function (row, ...args) {
      const state = window.__qaFault;
      if (this.name !== 'vaults' || row?.key !== vaultKey || ++state.writes !== 2) return original.call(this, row, ...args);
      if (mode === 'quota') throw new DOMException('Synthetic final-write quota failure', 'QuotaExceededError');
      const request = original.call(this, row, ...args), store = this, tx = store.transaction;
      tx.addEventListener('complete', () => { state.completed = true; });
      request.addEventListener('success', () => {
        state.candidate = row.value; state.pending = true;
        const keepAlive = () => { state.keptAlive++; store.get(vaultKey).onsuccess = keepAlive; }; keepAlive();
      });
      return request;
    };
  }, { vaultKey, mode });
}
try {
  let page = await launch('capacity-and-quota'); await unlock(page, true);
  const initial = decrypt(await readVaultCiphertext(page)), now = new Date().toISOString();
  const items = Array.from({ length: 500 }, (_, index) => ({ id: randomUUID(), revision: 1, kind: 'note', title: `原生容量记录 ${String(index).padStart(3, '0')}`,
    content: `${index}:` + '中'.repeat(20000 - String(index).length - 1), tags: [], createdAt: now, updatedAt: now, completedAt: null }));
  const drafts = Array.from({ length: 100 }, (_, index) => ({ id: index === 0 ? items[0].id : randomUUID(), editId: randomUUID(), baseRevision: index === 0 ? 1 : 0,
    input: { kind: 'note', title: `原生容量草稿 ${index}`, content: '草'.repeat(20000), tags: [] }, tagsText: '', dueText: '', timezone: 'Asia/Shanghai', updatedAt: now }));
  const conversations = Array.from({ length: 5 }, (_, index) => ({ id: randomUUID(), title: `原生容量会话 ${index}`, profileId: '', updatedAt: now,
    messages: [{ id: randomUUID(), role: 'user', content: `${index}:` + 'c'.repeat(900000 - String(index).length - 1), createdAt: now }] }));
  const fixture = { ...initial, personalItems: items, personalDrafts: drafts, conversations };
  // Mixed content reaches the character limit, but the 16 MiB snapshot
  // limit must also hold. Use mixed text to reach counts without exceeding it.
  for (const item of fixture.personalItems) item.content = item.content.slice(0, 20) + 'x'.repeat(19980);
  for (const draft of fixture.personalDrafts) draft.input.content = '草'.repeat(20) + 'd'.repeat(19980);
  expect(Buffer.byteLength(JSON.stringify(fixture))).toBeLessThanOrEqual(16 * 1024 * 1024);
  await button(page, '锁定本机密钥库').click();
  await writeVaultCiphertext(page, seal(fixture)); await page.reload();
  let started = performance.now(); await unlock(page); timings.capacityUnlockMs = Math.round(performance.now() - started);
  await button(page, items[0].title).click();
  await expect(field(page, '笔记或待办内容')).toHaveValue(drafts[0].input.content);
  started = performance.now(); await button(page, '保存记录').click();
  await expect(page.getByRole('status')).toHaveText('已保存到本机加密库。', { timeout: 30000 });
  timings.capacitySaveMs = Math.round(performance.now() - started);
  let data = decrypt(await readVaultCiphertext(page));
  expect(data.personalItems).toHaveLength(500); expect(data.personalDrafts).toHaveLength(99);
  expect(data.personalItems.find(item => item.id === items[0].id).content).toBe(drafts[0].input.content);
  expect(data.personalItems.filter(item => item.id !== items[0].id)).toEqual(items.slice(1));
  expect(data.personalDrafts).toEqual(drafts.slice(1));
  expect(data.conversations).toEqual(conversations);
  for (const [key, value] of Object.entries(initial)) {
    if (!['personalItems', 'personalDrafts', 'conversations'].includes(key)) expect(data[key], key).toEqual(value);
  }
  checks.push('packaged WebView2 saves and independently decrypts 500 notes, 100 starting drafts and five long conversations');

  await button(page, '工作台备份').click();
  await field(page, '备份口令').fill(backupPassword); await field(page, '确认备份口令').fill(backupPassword);
  started = performance.now(); const downloading = page.waitForEvent('download'); await button(page, '下载加密工作台备份').click();
  const backupFile = path.join(run, 'native-capacity.geiitwork'); await (await downloading).saveAs(backupFile);
  timings.backupMs = Math.round(performance.now() - started);
  const backup = await readFile(backupFile, 'utf8'); expect(decrypt(backup, backupPassword, true).data).toEqual(data);
  checks.push('actual native encrypted backup download independently decrypts to the complete current snapshot');
  await button(page, '笔记与待办').click(); await button(page, '笔记').click();
  const currentTitle = data.personalItems.find(item => item.id === items[0].id).title;
  await button(page, currentTitle).click();
  const quotaBody = '合成空间不足测试：草稿必须保留，重试不能重复建记录。';
  const beforeQuota = await rawDraft(page, quotaBody);
  await faultOnFinalWrite(page, 'quota'); await button(page, '保存记录').click();
  await expect(page.getByRole('alert').filter({ hasText: '本机保存失败' }).first()).toBeVisible({ timeout: 30000 });
  expect(await page.evaluate(() => window.__qaFault.writes)).toBe(2);
  await expect(page.getByRole('status').filter({ hasText: '已保存到本机加密库。' })).toHaveCount(0);
  expect(decrypt(await readVaultCiphertext(page))).toEqual(beforeQuota);
  await button(page, '重试本机保存').click();
  await expect(page.getByRole('status')).toHaveText('本机记录和草稿已重新保存。', { timeout: 30000 });
  data = decrypt(await readVaultCiphertext(page));
  expect(data.personalItems).toHaveLength(500); expect(data.personalDrafts).toHaveLength(99);
  expect(data.personalItems.find(item => item.id === items[0].id).revision).toBe(3);
  expect(data.personalItems.find(item => item.id === items[0].id).content).toBe(quotaBody);
  checks.push('injected final-write quota error keeps durable raw draft, reports failure and retries once without duplicate records');
  await close();

  page = await launch('interrupt-application-write'); await unlock(page);
  await button(page, currentTitle).click();
  const crashBody = '进程树强杀前已持久化的草稿，正式记录提交尚未完成。';
  const raw = await rawDraft(page, crashBody);
  await faultOnFinalWrite(page, 'hold'); await button(page, '保存记录').click();
  await expect.poll(() => page.evaluate(() => ({ pending: window.__qaFault.pending, active: window.__qaFault.keptAlive > 3, completed: window.__qaFault.completed })), { timeout: 30000 })
    .toEqual({ pending: true, active: true, completed: false });
  const uncommitted = decrypt(await page.evaluate(() => window.__qaFault.candidate));
  expect(uncommitted.personalItems.find(item => item.id === items[0].id).revision).toBe(4);
  expect(uncommitted.personalItems.find(item => item.id === items[0].id).content).toBe(crashBody);
  expect(uncommitted.personalDrafts.some(item => item.id === items[0].id)).toBe(false);
  await expect(page.getByRole('status').filter({ hasText: '已保存到本机加密库。' })).toHaveCount(0);
  await forceTree();

  page = await launch('recover-and-commit');
  const recoveredCiphertext = await readVaultCiphertext(page);
  expect(decrypt(recoveredCiphertext)).toEqual(raw);
  started = performance.now(); await unlock(page); timings.crashRestartUnlockMs = Math.round(performance.now() - started);
  await button(page, currentTitle).click(); await expect(field(page, '笔记或待办内容')).toHaveValue(crashBody);
  checks.push('force-killing native host and WebView2 process tree during an actual app write discards the uncommitted revision and recovers the complete prior snapshot and draft');
  await button(page, '保存记录').click();
  await expect(page.getByRole('status')).toHaveText('已保存到本机加密库。', { timeout: 30000 });
  const committed = await readVaultCiphertext(page), committedData = decrypt(committed);
  expect(committedData.personalItems.find(item => item.id === items[0].id).revision).toBe(4);
  expect(committedData.personalItems.find(item => item.id === items[0].id).content).toBe(crashBody);
  expect(committedData.personalDrafts).toHaveLength(99);
  await forceTree();

  page = await launch('recover-committed-write');
  expect(await readVaultCiphertext(page)).toBe(committed); await unlock(page);
  await button(page, currentTitle).click(); await expect(field(page, '笔记或待办内容')).toHaveValue(crashBody);
  await page.screenshot({ path: path.join(run, 'recovered.png') });
  checks.push('acknowledged committed write survives a second native process-tree termination and unlocks with the original password');
  const cdp = await active.browser.contexts()[0].newCDPSession(page), heap = (await cdp.send('Runtime.getHeapUsage')).usedSize;
  await close();
  expect(errors).toEqual([]); expect(externalAttempts).toEqual([]);
  const report = { passed: true, generatedAt: new Date().toISOString(), platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    executable: { path: executable, bytes: binary.length, sha256: createHash('sha256').update(binary).digest('hex') },
    profile, personalItems: 500, initialDrafts: 100, contentCharactersEach: 20000, conversations: 5, conversationCharactersEach: 900000,
    plaintextBytes: Buffer.byteLength(JSON.stringify(fixture)), backupBytes: Buffer.byteLength(backup), sampledJsHeapBytes: heap,
    timings, stages, checks, errors, externalAttempts,
    limits: ['synthetic data on development machine; not 8 GB or memory constrained', 'process termination and injected IndexedDB quota; not physical power loss, disk-full device or interrupted installer', 'no real model, email, database or deployment calls', 'no memory or latency SLA; exported test backup contains synthetic data only'] };
  await writeFile(path.join(run, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, checks: checks.length, report: path.join(run, 'result.json'), timings }));
} catch (error) {
  await active?.page?.screenshot({ path: path.join(run, 'failure.png'), timeout: 5000 }).catch(() => {});
  await writeFile(path.join(run, 'failure.json'), JSON.stringify({ error: String(error), stages, checks, errors, externalAttempts }, null, 2));
  throw error;
} finally { await close(); }
