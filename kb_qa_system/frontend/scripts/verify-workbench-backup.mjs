// Production UI + real browser/WebView crypto and downloads, synthetic data only.
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readVaultCiphertext, writeVaultCiphertext, removeVaultCiphertext, setVaultWriteFailure } from './vault-qa.mjs';

const native = process.argv.includes('--native'), key = 'geiit.workbench.encrypted.v1';
const output = path.resolve('../../.tools/workbench-backup-qa', native ? 'native' : 'web');
await mkdir(output, { recursive: true });
async function unusedPort() {
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); return port;
}
// Independent decoder verifies actual downloaded bytes, not application helpers.
function decrypt(text, password, backup = true) {
  const e = JSON.parse(text), bytes = Buffer.from(e.ciphertext, 'base64');
  const derived = pbkdf2Sync(password, Buffer.from(e.salt, 'base64'), 600000, 32, 'sha256');
  const decipher = createDecipheriv('aes-256-gcm', derived, Buffer.from(e.iv, 'base64'));
  decipher.setAAD(Buffer.from(backup ? 'geiit-workbench-backup:1' : 'geiit-private-workbench-v1'));
  decipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString('utf8'));
}
let app, browser, context, page;
const errors = [], requests = [];
try {
  const port = await unusedPort();
  if (native) {
    const profile = await mkdtemp(path.join(output, 'webview-'));
    app = spawn(path.resolve('src-tauri/target-dev/release/geiit-workbench.exe'), [], { windowsHide: true, stdio: 'ignore', env: {
      ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port,
    } });
    let launchError; app.on('error', error => { launchError = error; });
    for (let attempt = 0; attempt < 60; attempt++) {
      if (launchError) throw launchError;
      if (app.exitCode !== null) throw new Error('Native app exited');
      try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 700 }); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 200)); }
    }
    if (!browser) throw new Error('Native debugger unavailable');
    context = browser.contexts()[0]; page = context.pages()[0] || await context.waitForEvent('page');
  } else {
    const url = `http://127.0.0.1:${port}/workbench`;
    app = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--configLoader', 'runner', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { windowsHide: true, stdio: 'ignore' });
    let launchError; app.on('error', error => { launchError = error; });
    await expect.poll(async () => { if (launchError) throw launchError; try { return (await fetch(url)).ok; } catch { return false; } }, { timeout: 15000 }).toBe(true);
    browser = await chromium.launch({ headless: true }); context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
    page = await context.newPage(); await page.goto(url);
  }
  const observe = async () => {
    page.on('pageerror', error => errors.push(error.message));
    context.on('request', request => requests.push(request.url()));
    await context.route('**/api/v1/**', route => route.fulfill({ json: {} }));
    await context.routeWebSocket('**/ws/notifications', () => {});
  };
  await observe();
  const button = name => page.getByRole('button', { name, exact: true });
  const field = name => page.getByLabel(name, { exact: true });
  const stored = () => readVaultCiphertext(page, key);
  async function unlock(password, create = false) {
    await field('解锁口令').fill(password); if (create) await field('确认口令').fill(password);
    await button(create ? '创建' : '解锁').click(); await expect(page.getByText('本机密钥库已解锁', { exact: true })).toBeVisible();
  }
  async function exportFile(includeKeys) {
    await field('备份口令').fill('backup-1234'); await field('确认备份口令').fill('backup-1234');
    await field('在加密备份中包含模型 API Key').setChecked(includeKeys);
    const event = page.waitForEvent('download'); await button('下载加密工作台备份').click(); const download = await event;
    const filename = path.join(output, includeKeys ? 'with-keys.geiitwork' : 'without-keys.geiitwork'); await download.saveAs(filename);
    await expect(page.getByText('加密备份已生成并发起下载，请确认文件已保存。')).toBeVisible();
    return { filename, text: await readFile(filename, 'utf8') };
  }
  async function prepare(filename, password = 'backup-1234') {
    await field('工作台备份文件').setInputFiles(filename);
    await field('此备份的口令').fill(password); await field('恢复后的新解锁口令').fill('new-pass-5678'); await field('确认新解锁口令').fill('new-pass-5678');
    await button('解密并预检查备份').click();
  }
  await unlock('old-pass-1234', true);
  await page.evaluate(() => localStorage.setItem('backup-qa-unrelated', 'untouched'));
  await button('模型连接').click(); await field('调用方式').selectOption('local'); await field('连接名称').fill('合成备份连接');
  await field('模型名称').fill('synthetic-model'); await field('API Key').fill('synthetic-backup-key'); await button('保存连接').click();
  await expect(page.getByText('连接已加密保存到本机。')).toBeVisible();
  await button('新对话').click();
  await button('笔记与待办').click(); await button('笔记').click();
  await field('标题').fill('加密备份记录'); await field('笔记或待办内容').fill('# 记录\n\n需要跨设备恢复。'); await button('保存记录').click();
  await expect(page.getByRole('status')).toHaveText('已保存到本机加密库。');
  await button('新建笔记').click(); await field('笔记或待办内容').fill('尚无标题的草稿');
  await page.getByRole('tab', { name: '任务', exact: true }).click(); await page.getByRole('tab', { name: '图表工具', exact: true }).click();
  await button('检查并预览').click(); await button('保存图表任务').click();
  await expect(page.getByText('图表和检查记录已保存到本机加密库。')).toBeVisible();
  await button('工作台备份').click(); const apiBefore = requests.filter(url => url.includes('/api/')).length;
  const without = await exportFile(false), withKeys = await exportFile(true);
  const plain = decrypt(without.text, 'backup-1234'), secrets = decrypt(withKeys.text, 'backup-1234');
  expect(plain.data.profiles[0].apiKey).toBe(''); expect(secrets.data.profiles[0].apiKey).toBe('synthetic-backup-key');
  expect(plain.data.personalItems).toHaveLength(1); expect(plain.data.personalDrafts.some(d => d.input.content === '尚无标题的草稿')).toBe(true);
  expect(plain.data.artifacts[0].kind).toBe('svg'); expect(plain.data.conversations).toHaveLength(1);
  expect(withKeys.text).not.toMatch(/synthetic-backup-key|记录|backup-1234/);
  await button('锁定工作台以准备恢复').click(); await expect(button('解密并预检查备份')).toBeVisible();
  const original = await stored();
  await prepare(without.filename, 'incorrect-password'); await expect(page.getByRole('alert')).toContainText('口令不正确或文件已损坏'); expect(await stored()).toBe(original);
  await prepare(without.filename); await expect(page.getByRole('region', { name: '工作台恢复预览' })).toBeVisible();
  expect(await stored()).toBe(original); await expect(button('确认恢复工作台')).toBeDisabled(); await expect(field('此备份的口令')).toHaveValue('');
  await button('取消备份或恢复预检查').click(); await expect(button('确认恢复工作台')).toHaveCount(0); expect(await stored()).toBe(original);
  await prepare(without.filename); await expect(button('确认恢复工作台')).toBeVisible();
  // Genuine other-window IndexedDB write and notification, preserving valid ciphertext.
  if (native) await writeVaultCiphertext(page, original + ' ', key);
  else {
    const other = await context.newPage(); await other.goto(page.url());
    await writeVaultCiphertext(other, original + ' ', key); await other.close();
  }
  await field('我已核对备份内容并确认整体恢复到本机工作台').check(); await button('确认恢复工作台').click();
  await expect(page.getByRole('alert')).toContainText('未覆盖新数据'); expect(await stored()).toBe(original + ' ');
  await prepare(without.filename); await expect(button('确认恢复工作台')).toBeVisible();
  await setVaultWriteFailure(page, true);
  await field('我已核对备份内容并确认整体恢复到本机工作台').check(); await button('确认恢复工作台').click();
  await expect(page.getByRole('alert')).toContainText('原密钥库未更改'); expect(await stored()).toBe(original + ' ');
  await page.screenshot({ path: path.join(output, 'preview-quota.png') });
  if (!native) {
    await page.setViewportSize({ width: 390, height: 844 }); await button('确认恢复工作台').scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: path.join(output, 'mobile.png') }); await page.setViewportSize({ width: 1280, height: 900 });
  }
  await setVaultWriteFailure(page, false); await button('确认恢复工作台').click();
  await expect(page.getByText('恢复已完成。请使用刚设置的新解锁口令打开工作台。')).toBeVisible();
  expect(decrypt(await stored(), 'new-pass-5678', false)).toEqual(plain.data);
  expect(await page.evaluate(() => localStorage.getItem('backup-qa-unrelated'))).toBe('untouched');
  await button('返回工作台解锁').click(); await field('解锁口令').fill('old-pass-1234'); await button('解锁').click();
  await expect(page.getByText('口令错误或本机密钥库已损坏。')).toBeVisible(); await unlock('new-pass-5678');
  await button('笔记与待办').click(); await expect(field('笔记或待办内容')).toHaveValue('尚无标题的草稿');
  await page.reload(); await unlock('new-pass-5678'); await button('模型连接').click(); await button('编辑 合成备份连接').click();
  await expect(field('API Key')).toHaveAttribute('placeholder', '可选');
  // Fresh storage import, with keys. Native retains its isolated WebView profile
  // but removes only this test's vault; Web uses a genuinely new browser context.
  const url = page.url();
  if (!native) { await context.close(); context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } }); page = await context.newPage(); await observe(); await page.goto(url); }
  else { await button('锁定本机密钥库').click(); await removeVaultCiphertext(page, key); await page.reload(); }
  await button('工作台备份').click(); await prepare(withKeys.filename); await expect(page.getByText(/本机尚无密钥库，将从备份创建/)).toBeVisible();
  await field('我已核对备份内容并确认整体恢复到本机工作台').check(); await button('确认恢复工作台').click();
  await expect(page.getByText('恢复已完成。请使用刚设置的新解锁口令打开工作台。')).toBeVisible();
  expect(decrypt(await stored(), 'new-pass-5678', false)).toEqual(secrets.data);
  await button('返回工作台解锁').click(); await unlock('new-pass-5678'); await button('模型连接').click(); await button('编辑 合成备份连接').click();
  await expect(field('API Key')).toHaveAttribute('placeholder', '已保存；留空保持原密钥');
  await button('工作台备份').click(); await page.screenshot({ path: path.join(output, 'restored.png') });
  expect(errors).toEqual([]); expect(requests.filter(url => /11434|\/private-models\/|\/workbench-model\//.test(url))).toEqual([]);
  // Reload may perform app-level account probes; backup itself is entirely local.
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, native, apiCountBeforeBackup: apiBefore, checks: [
    'real UI note, draft, conversation, chart and model configuration', 'independent decryption of actual downloads', 'default key omission and explicit opt-in',
    'wrong password unchanged storage', 'preview without writes and explicit acknowledgement', 'cancel and ciphertext conflict',
    'quota-safe replacement retry', 'new local password and exact restored data', 'unrelated storage untouched', 'refresh and empty-vault restore',
    'no model requests or emails', ...(native ? ['same-page injected IndexedDB conflict'] : ['390px layout', 'fresh browser context', 'real other-window IndexedDB write']),
  ] }, null, 2));
  console.log(`Workbench backup ${native ? 'native' : 'web'} QA passed: ${output}`);
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ message: String(error), errors }, null, 2)); throw error;
} finally { await browser?.close(); app?.kill(); }
