// Packaged WebView2 + Rust + real Windows directories. The six native picker
// dialogs must be completed with the paths printed below (Computer Use/manual).
// No grant/path bypass or replacement picker. All files are synthetic in .tools.
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, readdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

const output = path.resolve('../../.tools/native-organizer-qa'); await mkdir(output, { recursive: true });
const run = await mkdtemp(path.join(output, 'run-')), source = path.join(run, 'source'), target = path.join(run, 'target');
await mkdir(source); await mkdir(target);
const original = { 'a.txt': 'synthetic A 中文', 'b.md': '# synthetic B\ncontent' };
for (const [name, text] of Object.entries(original)) await writeFile(path.join(source, name), text);
await writeFile(path.join(target, 'keep.txt'), 'untouched target');
const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const app = spawn(path.resolve('src-tauri/target-dev/release/geiit-workbench.exe'), [], { windowsHide: true, stdio: 'ignore', env: { ...process.env,
  WEBVIEW2_USER_DATA_FOLDER: path.join(run, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port,
} });
let launchError; app.on('error', error => { launchError = error; });
let browser, page, picker = 0;
const errors = [], commands = [];
async function files(directory) {
  const result = {}; for (const name of await readdir(directory)) result[name] = await readFile(path.join(directory, name), 'utf8'); return result;
}
async function pick(destination = false) {
  const selected = destination ? target : source;
  await writeFile(path.join(output, 'phase.json'), JSON.stringify({ step: ++picker, path: selected, run, port }));
  console.log('Native picker ' + picker + ': ' + selected);
  await page.getByRole('button', { name: destination ? '选择目标目录' : '选择可整理目录', exact: true }).click();
  await expect(page.getByText(destination ? '目标目录：target' : '当前可写目录：source', { exact: true })).toBeVisible({ timeout: 240000 });
}
async function selectBoth() {
  await pick(); await page.getByRole('checkbox', { name: '移动到另一个目录', exact: true }).check(); await pick(true);
}
async function reopen() {
  await page.reload(); await page.getByLabel('解锁口令', { exact: true }).fill('native-organizer-fixture');
  await page.getByRole('button', { name: '解锁', exact: true }).click();
  await page.getByRole('button', { name: '文件整理', exact: true }).click();
}
async function apply() {
  await page.getByRole('button', { name: '生成变更清单' }).click();
  await page.getByRole('button', { name: '应用可整理项目', exact: true }).click();
}
try {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (launchError) throw launchError;
    if (app.exitCode !== null) throw new Error('Native app exited');
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 700 }); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  if (!browser) throw new Error('Native debugger unavailable');
  const context = browser.contexts()[0]; page = context.pages()[0] || await context.waitForEvent('page');
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.getByRole('heading', { name: '创建本机密钥库' })).toBeVisible();
  await page.getByLabel('解锁口令', { exact: true }).fill('native-organizer-fixture');
  await page.getByLabel('确认口令', { exact: true }).fill('native-organizer-fixture');
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await page.getByRole('button', { name: '文件整理', exact: true }).click();
  await selectBoth(); await apply();
  await expect(page.getByRole('status')).toContainText('整理已完成', { timeout: 15000 });
  expect(await files(source)).toEqual({}); expect(await files(target)).toEqual({ ...original, 'keep.txt': 'untouched target' });
  const encrypted = await page.evaluate(() => localStorage.getItem('geiit.workbench.encrypted.v1'));
  expect(encrypted).not.toMatch(/a\.txt|b\.md|source|geiit-stage/);
  await page.screenshot({ path: path.join(run, 'native-moved.png') });
  await reopen();
  await page.locator('summary').filter({ hasText: '已完成' }).click();
  await expect(page.getByRole('button', { name: '预览撤销' })).toBeDisabled();
  await selectBoth();
  await page.getByRole('button', { name: '核验目录', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('目录核验完成');
  await page.getByRole('button', { name: '预览撤销' }).click();
  await expect(page.getByText('当前可写目录：target', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认撤销所选目录中的变更' }).click();
  await expect(page.getByRole('status')).toContainText('撤销已完成', { timeout: 15000 });
  expect(await files(source)).toEqual(original); expect(await files(target)).toEqual({ 'keep.txt': 'untouched target' });
  await page.getByRole('button', { name: '交换源/目标目录' }).click();
  await expect(page.getByText('当前可写目录：source', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    // Tauri's invoke is immutable. Intercept the transport's response in this
    // isolated QA page, retaining actual Rust access and picker permissions.
    const originalFetch = window.fetch.bind(window);
    window.__qaMode = ''; window.__qaRemoved = false; window.__qaCommands = [];
    window.fetch = async (url, options) => {
      const op = String(url).includes('ipc.localhost/organizer_access') ? JSON.parse(options.body).operation : undefined;
      if (op) window.__qaCommands.push(op.op);
      if (op?.op === 'remove' && op.name === 'b.md' && window.__qaMode === 'fail') {
        window.__qaMode = ''; return new Response('Synthetic second source deletion failure', { headers: { 'Content-Type': 'text/plain', 'Tauri-Response': 'error' } });
      }
      const result = await originalFetch(url, options);
      if (op?.op === 'remove' && op.name === 'a.txt' && ['cancel', 'interrupt'].includes(window.__qaMode)) {
        window.__qaRemoved = true; await new Promise(resolve => { window.__qaRelease = resolve; });
      }
      return result;
    };
  });
  await page.evaluate(() => { window.__qaMode = 'fail'; }); await apply();
  await expect(page.getByRole('alert')).toContainText('Synthetic');
  expect(await files(source)).toEqual(original); expect(await files(target)).toEqual({ 'keep.txt': 'untouched target' });
  await page.getByRole('button', { name: '重新读取目录' }).click();
  await page.evaluate(() => { window.__qaMode = 'cancel'; }); await apply();
  await page.waitForFunction(() => window.__qaRemoved);
  await page.getByRole('button', { name: '停止整理并恢复' }).click();
  await page.evaluate(() => { window.__qaMode = ''; window.__qaRelease(); });
  await expect(page.getByRole('alert')).toContainText('取消');
  expect(await files(source)).toEqual(original); expect(await files(target)).toEqual({ 'keep.txt': 'untouched target' });
  await page.getByRole('button', { name: '重新读取目录' }).click();
  // Change target after preview, then verify the execution preflight refuses it.
  await page.getByRole('button', { name: '生成变更清单' }).click();
  await writeFile(path.join(target, 'a.txt'), 'external fixture edit');
  await page.getByRole('button', { name: '应用可整理项目', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('冲突');
  expect(await files(source)).toEqual(original); expect(await readFile(path.join(target, 'a.txt'), 'utf8')).toBe('external fixture edit');
  await unlink(path.join(target, 'a.txt'));
  await page.getByRole('button', { name: '重新读取目录' }).click();
  await page.evaluate(() => { window.__qaMode = 'interrupt'; window.__qaRemoved = false; }); await apply();
  await page.waitForFunction(() => window.__qaRemoved);
  commands.push(...await page.evaluate(() => window.__qaCommands));
  const interruptedSource = await files(source), interruptedTarget = await files(target);
  expect(interruptedSource['a.txt']).toBeUndefined(); expect(interruptedSource['b.md']).toBe(original['b.md']);
  expect(Object.keys(interruptedSource).filter(name => name.startsWith('.geiit-stage-'))).toHaveLength(2);
  await reopen();
  await page.locator('summary').filter({ hasText: '中断待核验' }).click();
  await selectBoth();
  const record = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: '中断待核验' }) });
  await record.getByRole('button', { name: '核验目录', exact: true }).click();
  await expect(page.locator('summary').filter({ hasText: '需要人工检查' })).toHaveCount(1);
  expect(await files(source)).toEqual(interruptedSource); expect(await files(target)).toEqual(interruptedTarget);
  await page.screenshot({ path: path.join(run, 'native-interrupted.png') });
  expect(commands).toContain('copy'); expect(commands).toContain('hash'); expect(commands).not.toContain('read');
  expect(errors).toEqual([]);
  const result = { passed: true, nativePickers: picker, realExternalDirectories: true, crossDirectoryMove: true, encryptedReload: true, explicitUndo: true, deletionFailureCompensated: true, cancellationCompensated: true, postPreviewCollisionRefused: true, reloadAfterPartialDeletionRetainsCopies: true, mixedOutcomeReadOnlyInspection: true, pageErrors: errors };
  await writeFile(path.join(run, 'result.json'), JSON.stringify(result, null, 2));
  await writeFile(path.join(output, 'phase.json'), JSON.stringify({ complete: true, run }));
  console.log(JSON.stringify(result));
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(run, 'failure.png') }).catch(() => {}); await writeFile(path.join(run, 'failure.txt'), String(error) + '\n' + (await page.locator('body').innerText().catch(() => ''))); }
  throw error;
} finally { await browser?.close(); app.kill(); }
