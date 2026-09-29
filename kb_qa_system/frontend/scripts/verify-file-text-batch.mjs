// Production Chromium OPFS (--web), or packaged WebView2/Rust with real picker.
// The native folder dialogs use the path printed in phase.json; select them with
// Computer Use/manual interaction. No injected native grants or absolute-path IPC.
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const native = !process.argv.includes('--web'), mode = native ? 'native' : 'web';
const output = path.resolve('../../.tools/file-text-batch-qa', mode); await mkdir(output, { recursive: true });
const run = await mkdtemp(path.join(output, 'run-')), directory = path.join(run, 'batch-fixture'); await mkdir(directory);
const original = '\ufeffold 中文🙂\r\nold line\r\n';
for (const name of ['a.md', 'b.txt', 'c.md']) await writeFile(path.join(directory, name), original);
const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
let app, browser, page, launchError, picker = 0;
const errors = [];
async function current(name = 'a.md') {
  if (native) return readFile(path.join(directory, name), 'utf8');
  return page.evaluate(async name => { const root = await navigator.storage.getDirectory(); const dir = await root.getDirectoryHandle('batch-fixture'); const file = await (await dir.getFileHandle(name)).getFile(); return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await file.arrayBuffer()); }, name);
}
async function external(text, name = 'a.md') {
  if (native) await writeFile(path.join(directory, name), text);
  else await page.evaluate(async ({ text, name }) => { const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('batch-fixture'); const writer = await (await dir.getFileHandle(name)).createWritable(); await writer.write(text); await writer.close(); }, { text, name });
}
async function installFixtureHooks() {
  await page.evaluate(async ({ native }) => {
    window.__qaWriteCount = 0; window.__qaFault = ''; window.__qaFailVault = false;
    const save = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) { if (key === 'geiit.workbench.encrypted.v1' && window.__qaFailVault) throw new DOMException('Synthetic quota', 'QuotaExceededError'); return save.call(this, key, value); };
    if (native) {
      const fetchOriginal = window.fetch.bind(window);
      window.fetch = async (url, options) => {
        const op = String(url).includes('ipc.localhost/organizer_access') ? JSON.parse(options.body).operation : undefined;
        const response = await fetchOriginal(url, options);
        if (op?.op === 'write_text') { window.__qaWriteCount++; if (window.__qaFault === 'final-save') window.__qaFailVault = true; }
        return response;
      };
    } else {
      window.showDirectoryPicker = async () => {
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('batch-fixture', { create: true });
        return { name: dir.name, values: () => dir.values(), removeEntry: name => dir.removeEntry(name), getFileHandle: async name => {
          const handle = await dir.getFileHandle(name);
          return { underlying: handle, getFile: () => handle.getFile(), isSameEntry: other => handle.isSameEntry(other.underlying), createWritable: async () => {
            const writer = await handle.createWritable();
            return { write: bytes => writer.write(bytes), abort: () => writer.abort(), close: async () => { await writer.close(); window.__qaWriteCount++; if (window.__qaFault === 'final-save') window.__qaFailVault = true; } };
          } };
        } };
      };
    }
  }, { native });
}
async function choose() {
  if (native) { await writeFile(path.join(output, 'phase.json'), JSON.stringify({ step: ++picker, path: directory, run, port })); console.log('Native picker ' + picker + ': ' + directory); }
  await page.getByRole('button', { name: '选择批量编辑目录' }).click();
  await expect(page.getByText(/批量目录：batch-fixture/)).toBeVisible({ timeout: 240000 });
  if (!native) await page.getByLabel(/我确认批量编辑/).check();
}
async function preview() {
  for (const name of ['a.md', 'b.txt', 'c.md']) await page.getByLabel('批量选择文件：' + name, { exact: true }).check();
  await page.getByLabel('批量查找内容', { exact: true }).fill('old'); await page.getByLabel('批量替换内容（可为空）', { exact: true }).fill('new');
  await page.getByRole('button', { name: '读取并预览批次', exact: true }).click(); await expect(page.getByRole('region', { name: '批量文本预览' })).toBeVisible();
}
async function commit(success = true) {
  await page.getByLabel(/我已检查所选文件差异/).check(); await page.getByRole('button', { name: '确认写入批次', exact: true }).click();
  if (success) await expect(page.getByRole('status')).toContainText('所选文件已全部写入并校验');
}
try {
  if (native) {
    app = spawn(path.resolve('src-tauri/target-dev/release/geiit-workbench.exe'), [], { windowsHide: true, stdio: 'ignore', env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: path.join(run, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port } });
    app.on('error', e => { launchError = e; });
    for (let i = 0; i < 60; i++) { if (launchError) throw launchError; if (app.exitCode !== null) throw new Error('Native app exited'); try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 700 }); break; } catch { await new Promise(r => setTimeout(r, 200)); } }
    if (!browser) throw new Error('Native debugger unavailable'); const context = browser.contexts()[0]; page = context.pages()[0] || await context.waitForEvent('page');
  } else {
    app = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { windowsHide: true, stdio: 'ignore' });
    app.on('error', e => { launchError = e; }); const url = 'http://127.0.0.1:' + port + '/workbench';
    await expect.poll(async () => { if (launchError) throw launchError; try { return (await fetch(url)).ok; } catch { return false; } }, { timeout: 15000 }).toBe(true);
    browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true }); await page.goto(url);
  }
  page.on('pageerror', e => errors.push(e.message)); page.on('dialog', dialog => dialog.accept());
  await expect(page.getByRole('heading', { name: '创建本机密钥库' })).toBeVisible();
  await page.getByLabel('解锁口令', { exact: true }).fill('text-edit-fixture-pass'); await page.getByLabel('确认口令', { exact: true }).fill('text-edit-fixture-pass');
  await page.getByRole('button', { name: '创建', exact: true }).click(); await page.getByRole('button', { name: '文件整理', exact: true }).click();
  await page.getByRole('tab', { name: '批量文本编辑' }).click(); await installFixtureHooks();
  if (!native) await page.evaluate(async text => { const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('batch-fixture', { create: true }); for (const name of ['a.md', 'b.txt', 'c.md']) { const writer = await (await dir.getFileHandle(name, { create: true })).createWritable(); await writer.write(text); await writer.close(); } }, original);
  await choose(); await preview();
  await expect(page.getByRole('button', { name: '确认写入批次', exact: true })).toBeDisabled();
  await external('external conflict', 'b.txt'); await commit(false);
  await expect(page.getByRole('alert')).toContainText('外部修改'); expect(await current()).toBe(original); expect(await page.evaluate(() => window.__qaWriteCount)).toBe(0);
  await external(original, 'b.txt'); await preview();
  await page.screenshot({ path: path.join(run, 'preview.png') });
  if (!native) { await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(run, 'mobile.png') }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.setViewportSize({ width: 1280, height: 900 }); }
  await commit(); for (const name of ['a.md', 'b.txt', 'c.md']) expect(await current(name)).toBe(original.replaceAll('old', 'new'));
  expect(await page.evaluate(() => window.__qaWriteCount)).toBe(3);
  let batch = page.locator('details').first(); await batch.locator('summary').click();
  const exportEvent = page.waitForEvent('download'); await batch.getByRole('button', { name: '导出批次记录（明文）' }).click();
  const historyFile = await exportEvent, historyPath = path.join(run, 'history.json'); await historyFile.saveAs(historyPath);
  const history = JSON.parse(await readFile(historyPath, 'utf8')); expect(history.records).toHaveLength(3); expect(history.records.every(r => r.status === 'succeeded' && r.before.text === original)).toBe(true);
  await batch.getByRole('button', { name: '预览恢复批次原文' }).click(); await expect(page.getByRole('region', { name: '批量文本预览' })).toContainText('恢复原文预览');
  await commit(); for (const name of ['a.md', 'b.txt', 'c.md']) expect(await current(name)).toBe(original);
  expect(await page.evaluate(() => window.__qaWriteCount)).toBe(6);
  await preview(); await page.evaluate(() => { window.__qaFault = 'final-save'; }); await commit(false);
  await expect(page.getByText(/文件可能已经部分写入；重试只保存记录/)).toBeVisible(); expect(await current()).toBe(original.replaceAll('old', 'new')); expect(await current('b.txt')).toBe(original); expect(await current('c.md')).toBe(original);
  const writesBeforeRefresh = await page.evaluate(() => window.__qaWriteCount); expect(writesBeforeRefresh).toBe(7);
  await page.evaluate(() => { window.__qaFault = ''; window.__qaFailVault = false; }); await page.getByRole('button', { name: '重试批次记录保存' }).click(); await expect(page.getByRole('button', { name: '重试批次记录保存' })).toHaveCount(0);
  expect(await page.evaluate(() => window.__qaWriteCount)).toBe(7);
  const encrypted = await page.evaluate(() => localStorage.getItem('geiit.workbench.encrypted.v1')); expect(encrypted).not.toMatch(/old|batch-fixture|a\.md/);
  await page.reload(); await page.getByLabel('解锁口令', { exact: true }).fill('text-edit-fixture-pass'); await page.getByRole('button', { name: '解锁', exact: true }).click();
  await page.getByRole('button', { name: '文件整理', exact: true }).click(); await page.getByRole('tab', { name: '批量文本编辑' }).click();
  await expect(page.locator('details')).toHaveCount(3); await installFixtureHooks(); await choose();
  batch = page.locator('details').first(); await batch.locator('summary').click(); await expect(batch).toContainText('b.txt · 未执行'); await expect(batch).toContainText('c.md · 未执行');
  await batch.getByRole('button', { name: '核验批次文件' }).click(); await expect(batch).toContainText('核验：after');
  await batch.getByRole('button', { name: '预览恢复批次原文' }).click(); await expect(page.getByRole('region', { name: '批量文本预览' })).toContainText('选中 1 个变更');
  await expect(page.getByLabel('应用批次变更：b.txt', { exact: true })).toBeDisabled(); await commit();
  expect(await page.evaluate(() => window.__qaWriteCount)).toBe(1); for (const name of ['a.md', 'b.txt', 'c.md']) expect(await current(name)).toBe(original);
  await page.screenshot({ path: path.join(run, 'history.png') }); expect(errors).toEqual([]);
  const result = { passed: true, mode, nativePickers: picker, writes: writesBeforeRefresh + 1, checks: ['all-file preflight rejects external change without writes', 'three-file exact BOM/CRLF replacement', 'actual history JSON bytes', 'whole-batch explicit restore', 'partial final-save quota failure stops subsequent files', 'storage retry does not replay writes', 'refresh keeps partial states', 'read-only inspection', 'partial restore skips unstarted files', ...(native ? [] : ['390px layout'])], pageErrors: errors };
  await writeFile(path.join(run, 'result.json'), JSON.stringify(result, null, 2)); await writeFile(path.join(output, 'phase.json'), JSON.stringify({ complete: true, run })); console.log(JSON.stringify(result));
} catch (e) { if (page) { await page.screenshot({ path: path.join(run, 'failure.png') }).catch(() => {}); await writeFile(path.join(run, 'failure.txt'), String(e) + '\n' + await page.locator('body').innerText().catch(() => '')); } throw e; }
finally { await browser?.close(); app?.kill(); }
