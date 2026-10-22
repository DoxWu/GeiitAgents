// Real packaged Windows WebView2 and synthetic profiles only; never installs an app.
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readVaultCiphertext } from './vault-qa.mjs';

const { values } = parseArgs({ options: {
  'old-exe': { type: 'string' }, 'new-exe': { type: 'string' }, output: { type: 'string' },
  'verify-exe': { type: 'string' }, 'profile-dir': { type: 'string' },
} });
const verifyOnly = Boolean(values['verify-exe']);
if (process.platform !== 'win32' || (verifyOnly ? !values['profile-dir'] : (!values['old-exe'] || !values['new-exe']))) {
  throw new Error('Windows required. Pass --old-exe/--new-exe or --verify-exe/--profile-dir.');
}
const oldExe = verifyOnly ? '' : path.resolve(values['old-exe']);
const newExe = verifyOnly ? '' : path.resolve(values['new-exe']);
const output = path.resolve(values.output ?? '../../.tools/native-upgrade-qa');
await mkdir(output, { recursive: true });
const run = await mkdtemp(path.join(output, 'run-'));
const sharedProfile = verifyOnly ? path.resolve(values['profile-dir']) : path.join(run, 'shared-profile');
const restoreProfile = path.join(run, 'restore-profile');
const password = 'synthetic-upgrade-pass', backupPassword = 'synthetic-backup-pass';
const noteTitle = '原生升级合成笔记', noteBody = '# 升级前记录\n\n保留中文、换行和 emoji 🌏。';
const draftBody = '跨版本保留的未提交草稿', editedBody = `${noteBody}\n\n升级后已编辑。`;
const errors = [], externalAttempts = [], checks = [], stages = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const binaries = verifyOnly ? [] : await Promise.all([oldExe, newExe].map(async executable => {
  const bytes = await readFile(executable);
  return { path: executable, sha256: hash(bytes), bytes: bytes.length };
}));
if (!verifyOnly && binaries[0].sha256 === binaries[1].sha256) throw new Error('Upgrade requires two different executable builds.');

// Independent decoder; no application decryption/normalization code is reused.
function decrypt(text, secret, backup = false) {
  const envelope = JSON.parse(text), bytes = Buffer.from(envelope.ciphertext, 'base64');
  const key = pbkdf2Sync(secret, Buffer.from(envelope.salt, 'base64'), 600000, 32, 'sha256');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(Buffer.from(backup ? 'geiit-workbench-backup:1' : 'geiit-private-workbench-v1'));
  decipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString('utf8'));
}
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function withApp(executable, profile, stage, action) {
  await mkdir(profile, { recursive: true });
  const port = await freePort();
  const app = spawn(executable, [], { windowsHide: true, stdio: 'ignore', env: {
    ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`,
  } });
  let launchError, browser, page;
  app.on('error', error => { launchError = error; });
  const exited = once(app, 'exit').catch(() => {});
  try {
    await expect.poll(async () => {
      if (launchError) throw launchError;
      if (app.exitCode !== null) throw new Error(`Native app exited at ${stage}`);
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 500 }); return true; }
      catch { return false; }
    }, { timeout: 30000 }).toBe(true);
    const context = browser.contexts()[0];
    page = context.pages()[0] ?? await context.waitForEvent('page');
    page.on('pageerror', error => errors.push({ stage, message: error.message }));
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/v1/')) return route.fulfill({ json: {} });
      if (/^https?:$/.test(url.protocol) && !['tauri.localhost', 'localhost', '127.0.0.1'].includes(url.hostname)) {
        externalAttempts.push({ stage, origin: url.origin });
        return route.abort();
      }
      return route.continue();
    });
    await context.routeWebSocket('**/ws/notifications', () => {});
    stages.push({ stage, webview: browser.version(), origin: new URL(page.url()).origin });
    console.log(`Native migration stage: ${stage}`);
    await action(page);
  } catch (error) {
    await page?.screenshot({ path: path.join(run, `${stage}-failure.png`) }).catch(() => {});
    throw error;
  } finally {
    await browser?.close().catch(() => {});
    if (app.exitCode === null) app.kill();
    let timer;
    try {
      await Promise.race([exited, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Native app did not exit at ${stage}; PID ${app.pid}`)), 10000);
      })]);
    } finally { clearTimeout(timer); }
  }
}
const button = (page, name) => page.getByRole('button', { name, exact: true });
const field = (page, name) => page.getByLabel(name, { exact: true });
async function unlock(page, secret = password, create = false) {
  await field(page, '解锁口令').fill(secret);
  if (create) await field(page, '确认口令').fill(secret);
  await button(page, create ? '创建' : '解锁').click();
  await expect(page.getByText('本机密钥库已解锁', { exact: true })).toBeVisible();
}
async function lockedSnapshot(page, secret = password) {
  await button(page, '锁定本机密钥库').click();
  const text = await readVaultCiphertext(page);
  expect(text).not.toContain(noteTitle);
  expect(text).not.toContain('synthetic-upgrade-key');
  return decrypt(text, secret);
}
function preserved(actual, expected) {
  for (const [key, value] of Object.entries(expected)) expect(actual[key], key).toEqual(value);
}
if (verifyOnly) {
  await withApp(path.resolve(values['verify-exe']), sharedProfile, 'installed-rollback-read', async page => {
    await expect(page.getByRole('heading', { name: '解锁工作台', exact: true })).toBeVisible();
    await unlock(page);
    await button(page, '笔记与待办').click();
    await expect(field(page, '笔记或待办内容')).toHaveValue(draftBody);
    await button(page, noteTitle).click();
    await expect(field(page, '笔记或待办内容')).toHaveValue(editedBody);
    const snapshot = await lockedSnapshot(page);
    expect(snapshot.personalItems[0].content).toBe(editedBody);
  });
  expect(errors).toEqual([]); expect(externalAttempts).toEqual([]);
  await writeFile(path.join(run, 'result.json'), JSON.stringify({ passed: true, stage: 'installed-rollback-read', profile: sharedProfile, errors, externalAttempts }, null, 2));
  console.log(JSON.stringify({ passed: true, stage: 'installed-rollback-read', report: path.join(run, 'result.json') }));
} else {
let baseline, current, backupData;
const backupFile = path.join(run, 'old-version.geiitwork');
try {
  await withApp(oldExe, sharedProfile, 'old-create', async page => {
    await unlock(page, password, true);
    await page.evaluate(() => localStorage.setItem('native-upgrade-unrelated', 'preserve-this'));
    await button(page, '模型连接').click();
    await field(page, '调用方式').selectOption('local');
    await field(page, '连接名称').fill('原生升级合成连接');
    await field(page, '模型名称').fill('synthetic-no-calls');
    await field(page, 'API Key').fill('synthetic-upgrade-key');
    await button(page, '保存连接').click();
    await expect(page.getByText('连接已加密保存到本机。', { exact: true })).toBeVisible();
    await button(page, '新对话').click();
    await button(page, '笔记与待办').click(); await button(page, '笔记').click();
    await field(page, '标题').fill(noteTitle); await field(page, '笔记或待办内容').fill(noteBody);
    await button(page, '保存记录').click();
    await expect(page.getByRole('status')).toHaveText('已保存到本机加密库。');
    await button(page, '新建笔记').click(); await field(page, '笔记或待办内容').fill(draftBody);
    await page.getByRole('tab', { name: '任务', exact: true }).click();
    await page.getByRole('tab', { name: '图表工具', exact: true }).click();
    await button(page, '检查并预览').click(); await button(page, '保存图表任务').click();
    await expect(page.getByText('图表和检查记录已保存到本机加密库。', { exact: true })).toBeVisible();
    await button(page, '工作台备份').click();
    await field(page, '备份口令').fill(backupPassword); await field(page, '确认备份口令').fill(backupPassword);
    await field(page, '在加密备份中包含模型 API Key').check();
    const downloading = page.waitForEvent('download');
    await button(page, '下载加密工作台备份').click();
    await (await downloading).saveAs(backupFile);
    backupData = decrypt(await readFile(backupFile, 'utf8'), backupPassword, true).data;
    baseline = await lockedSnapshot(page);
    expect(baseline.profiles).toHaveLength(1); expect(baseline.conversations).toHaveLength(1);
    expect(baseline.personalItems).toHaveLength(1); expect(baseline.artifacts).toHaveLength(1);
    expect(baseline.personalDrafts.some(item => item.input.content === draftBody)).toBe(true);
    preserved(backupData, baseline);
    checks.push('old binary UI creates and encrypts model connection, conversation, note, draft and chart task');
    checks.push('old downloaded backup independently decrypts to the complete persisted data');
  });
  await withApp(newExe, sharedProfile, 'new-open-edit', async page => {
    await expect(page.getByRole('heading', { name: '解锁工作台', exact: true })).toBeVisible();
    await unlock(page);
    preserved(await lockedSnapshot(page), baseline);
    await unlock(page); await button(page, '笔记与待办').click();
    await expect(field(page, '笔记或待办内容')).toHaveValue(draftBody);
    await button(page, noteTitle).click(); await expect(field(page, '笔记或待办内容')).toHaveValue(noteBody);
    await field(page, '笔记或待办内容').fill(editedBody); await button(page, '保存记录').click();
    await expect(page.getByRole('status')).toHaveText('已保存到本机加密库。');
    current = await lockedSnapshot(page);
    expect(current.personalItems[0].content).toBe(editedBody);
    expect(await page.evaluate(() => localStorage.getItem('native-upgrade-unrelated'))).toBe('preserve-this');
    checks.push('new binary opens old profile with the original password and preserves every existing data field');
    checks.push('old note and unsaved draft visible; editing works without changing unrelated storage');
  });
  await withApp(newExe, sharedProfile, 'new-restart', async page => {
    await unlock(page); preserved(await lockedSnapshot(page), current);
    checks.push('new binary restart preserves the edited encrypted vault');
  });
  await withApp(oldExe, sharedProfile, 'old-rollback-read', async page => {
    await unlock(page); preserved(await lockedSnapshot(page), current);
    checks.push('old binary reads the shared-format edited vault after switching back');
  });
  await withApp(newExe, restoreProfile, 'new-restore-old-backup', async page => {
    await button(page, '工作台备份').click();
    await field(page, '工作台备份文件').setInputFiles(backupFile);
    await field(page, '此备份的口令').fill(backupPassword);
    await field(page, '恢复后的新解锁口令').fill('synthetic-restored-pass');
    await field(page, '确认新解锁口令').fill('synthetic-restored-pass');
    await button(page, '解密并预检查备份').click();
    await expect(page.getByRole('region', { name: '工作台恢复预览' })).toBeVisible();
    await field(page, '我已核对备份内容并确认整体恢复到本机工作台').check();
    await button(page, '确认恢复工作台').click();
    await expect(page.getByText('恢复已完成。请使用刚设置的新解锁口令打开工作台。', { exact: true })).toBeVisible();
    preserved(decrypt(await readVaultCiphertext(page), 'synthetic-restored-pass'), backupData);
    await button(page, '返回工作台解锁').click(); await unlock(page, 'synthetic-restored-pass');
    await button(page, '笔记与待办').click(); await expect(field(page, '笔记或待办内容')).toHaveValue(draftBody);
    await page.screenshot({ path: path.join(run, 'restored.png') });
    checks.push('new binary restores the old encrypted backup into a separate empty profile with a new password');
  });
  expect(errors).toEqual([]); expect(externalAttempts).toEqual([]);
  const report = { passed: true, generatedAt: new Date().toISOString(), platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    scope: 'Packaged executable/profile migration and old-backup restore; not installer, uninstall, interrupted upgrade, new-only data downgrade or physical power-loss acceptance.',
    binaries, stages, checks, errors, externalAttempts };
  await writeFile(path.join(run, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, report: path.join(run, 'result.json'), checks: checks.length }));
} catch (error) {
  await writeFile(path.join(run, 'failure.json'), JSON.stringify({ error: String(error), binaries, stages, checks, errors, externalAttempts }, null, 2));
  throw error;
}
}
