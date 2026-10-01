import { readVaultCiphertext, setVaultWriteFailure } from './vault-qa.mjs';
// Production Chromium OPFS (--web), or packaged WebView2/Rust with real picker.
// The native folder dialogs use the path printed in phase.json; select them with
// Computer Use/manual interaction. No injected native grants or absolute-path IPC.
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const native = !process.argv.includes('--web'), mode = native ? 'native' : 'web';
const output = path.resolve('../../.tools/file-text-edit-qa', mode); await mkdir(output, { recursive: true });
const run = await mkdtemp(path.join(output, 'run-')), directory = path.join(run, 'text-fixture'); await mkdir(directory);
const original = '\ufeff# Synthetic 中文🙂\r\noriginal line\r\n';
await writeFile(path.join(directory, 'a.md'), original);
const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
let app, browser, page, launchError, picker = 0;
const errors = [];
async function current() {
  if (native) return readFile(path.join(directory, 'a.md'), 'utf8');
  return page.evaluate(async () => { const root = await navigator.storage.getDirectory(); const dir = await root.getDirectoryHandle('text-fixture'); const file = await (await dir.getFileHandle('a.md')).getFile(); return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await file.arrayBuffer()); });
}
async function external(text) {
  if (native) await writeFile(path.join(directory, 'a.md'), text);
  else await page.evaluate(async text => { const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('text-fixture'); const writer = await (await dir.getFileHandle('a.md')).createWritable(); await writer.write(text); await writer.close(); }, text);
}
async function installFixtureHooks() {
  await setVaultWriteFailure(page, false);
  await page.evaluate(async ({ native }) => {
    window.__qaWriteCount = 0; window.__qaFault = ''; window.__qaFailVault = false;
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
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('text-fixture', { create: true });
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
  await page.getByRole('button', { name: '选择文本编辑目录' }).click();
  await expect(page.getByText(/已授权目录：text-fixture/)).toBeVisible({ timeout: 240000 });
  if (!native) await page.getByRole('checkbox').check();
}
async function read() {
  await page.getByLabel('目录中的文本文件').selectOption('a.md'); await page.getByRole('button', { name: '读取并编辑' }).click();
  await expect(page.getByLabel('文本编辑内容')).toBeVisible();
}
async function preview(text) {
  if (text !== undefined) await page.getByLabel('文本编辑内容').fill(text);
  await page.getByRole('button', { name: '预览文本差异' }).click();
  await expect(page.getByRole('region', { name: '文本差异预览' })).toBeVisible();
}
async function commit() { await page.getByRole('button', { name: '确认写入所选文件' }).click(); }
async function discard() { await page.getByRole('button', { name: '丢弃文本草稿' }).click(); await expect(page.getByLabel('文本编辑内容')).toHaveCount(0); }
try {
  if (native) {
    app = spawn(path.resolve('src-tauri/target-dev/release/geiit-workbench.exe'), [], { windowsHide: true, stdio: 'ignore', env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: path.join(run, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port } });
    app.on('error', e => { launchError = e; });
    for (let i = 0; i < 60; i++) { if (launchError) throw launchError; if (app.exitCode !== null) throw new Error('Native app exited'); try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 700 }); break; } catch { await new Promise(r => setTimeout(r, 200)); } }
    if (!browser) throw new Error('Native debugger unavailable'); const context = browser.contexts()[0]; page = context.pages()[0] || await context.waitForEvent('page');
  } else {
    app = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--configLoader', 'runner', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { windowsHide: true, stdio: 'ignore' });
    app.on('error', e => { launchError = e; }); const url = 'http://127.0.0.1:' + port + '/workbench';
    await expect.poll(async () => { if (launchError) throw launchError; try { return (await fetch(url)).ok; } catch { return false; } }, { timeout: 15000 }).toBe(true);
    browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true }); await page.goto(url);
  }
  page.on('pageerror', e => errors.push(e.message)); page.on('dialog', dialog => dialog.accept());
  await expect(page.getByRole('heading', { name: '创建本机密钥库' })).toBeVisible();
  await page.getByLabel('解锁口令', { exact: true }).fill('text-edit-fixture-pass'); await page.getByLabel('确认口令', { exact: true }).fill('text-edit-fixture-pass');
  await page.getByRole('button', { name: '创建', exact: true }).click(); await page.getByRole('button', { name: '文件整理', exact: true }).click();
  await page.getByRole('tab', { name: '文本内容编辑' }).click(); await installFixtureHooks();
  if (!native) await page.evaluate(async text => { const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('text-fixture', { create: true }); const writer = await (await dir.getFileHandle('a.md', { create: true })).createWritable(); await writer.write(text); await writer.close(); }, original);
  await choose(); await read(); await preview('# Draft retained\noriginal line\n');
  await expect(page.getByRole('region', { name: '文本编辑草稿' })).toContainText('草稿已加密保存');
  expect(await current()).toBe(original);
  await page.reload(); await page.getByLabel('解锁口令', { exact: true }).fill('text-edit-fixture-pass'); await page.getByRole('button', { name: '解锁', exact: true }).click();
  await page.getByRole('button', { name: '文件整理', exact: true }).click(); await page.getByRole('tab', { name: '文本内容编辑' }).click();
  await expect(page.getByLabel('文本编辑内容')).toHaveValue('# Draft retained\noriginal line\n'); await preview();
  await expect(page.getByRole('button', { name: '确认写入所选文件' })).toBeDisabled();
  await installFixtureHooks(); await choose(); await preview();
  await external('\ufeff# Synthetic 中文🙂\r\nExternal line\r\n'); await commit(); await expect(page.getByRole('alert')).toContainText('外部修改');
  expect(await current()).toBe('\ufeff# Synthetic 中文🙂\r\nExternal line\r\n'); expect(await page.evaluate(() => window.__qaWriteCount)).toBe(0);
  await page.getByRole('button', { name: '合并不冲突的外部修改' }).click();
  await expect(page.getByRole('region', { name: '三方合并记录' })).toBeVisible();
  await expect(page.getByLabel('文本编辑内容')).toHaveValue('# Draft retained\nExternal line\n');
  await page.screenshot({ path: path.join(run, 'merge.png') });
  expect(await current()).toBe('\ufeff# Synthetic 中文🙂\r\nExternal line\r\n');
  const exported = page.waitForEvent('download'); await page.getByRole('button', { name: '导出草稿（明文）', exact: true }).click();
  const download = await exported; const exportedPath = path.join(run, 'draft.md'); await download.saveAs(exportedPath); expect(await readFile(exportedPath, 'utf8')).toBe('\ufeff# Draft retained\r\nExternal line\r\n');
  await commit(); await expect(page.getByRole('status')).toContainText('文件已写入并校验');
  expect(await current()).toBe('\ufeff# Draft retained\r\nExternal line\r\n');
  await external(original); await read(); await preview('# Saved 中文🙂\n');
  await page.screenshot({ path: path.join(run, 'preview.png') }); await commit();
  await expect(page.getByRole('status')).toContainText('文件已写入并校验'); expect(await current()).toBe('\ufeff# Saved 中文🙂\r\n');
  const record = page.locator('details').first(); await record.locator('summary').click(); await record.getByRole('button', { name: '预览恢复此记录原文' }).click();
  await expect(page.getByRole('region', { name: '文本差异预览' })).toBeVisible(); expect(await current()).toBe('\ufeff# Saved 中文🙂\r\n'); await commit();
  await expect(page.getByRole('status')).toContainText('文件已写入并校验'); expect(await current()).toBe(original); await expect(page.locator('details')).toHaveCount(3);
  await read(); await preview('# Durable despite quota\n'); await page.evaluate(() => { window.__qaFault = 'final-save'; }); await commit();
  await expect(page.getByText(/文件可能已经写入；重试仅保存本机记录/)).toBeVisible(); expect(await current()).toBe('\ufeff# Durable despite quota\r\n');
  const writes = await page.evaluate(() => window.__qaWriteCount); expect(writes).toBe(4);
  await page.evaluate(() => { window.__qaFault = ''; window.__qaFailVault = false; }); await page.getByRole('button', { name: '重试本机保存' }).click();
  await expect(page.getByRole('button', { name: '重试本机保存' })).toHaveCount(0); expect(await page.evaluate(() => window.__qaWriteCount)).toBe(writes);
  const encrypted = await readVaultCiphertext(page); expect(encrypted).not.toMatch(/Synthetic|Durable|text-fixture|a\.md/);
  await page.reload(); await page.getByLabel('解锁口令', { exact: true }).fill('text-edit-fixture-pass'); await page.getByRole('button', { name: '解锁', exact: true }).click();
  await page.getByRole('button', { name: '文件整理', exact: true }).click(); await page.getByRole('tab', { name: '文本内容编辑' }).click();
  await expect(page.locator('details')).toHaveCount(4); await expect(page.getByLabel('文本编辑内容')).toHaveCount(0);
  await page.screenshot({ path: path.join(run, 'history.png') });
  if (!native) { await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(run, 'mobile.png') }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
  expect(errors).toEqual([]);
  const result = { passed: true, mode, nativePickers: picker, writes, draftReload: true, explicitPreview: true, conflictPreserved: true, nonOverlappingMerge: true, plaintextExport: true, bomCrlfPreserved: true, restoreAppendsRecord: true, finalSaveFailureRetryWithoutReplay: true, encryptedHistoryReload: true, pageErrors: errors };
  await writeFile(path.join(run, 'result.json'), JSON.stringify(result, null, 2)); await writeFile(path.join(output, 'phase.json'), JSON.stringify({ complete: true, run })); console.log(JSON.stringify(result));
} catch (e) { if (page) { await page.screenshot({ path: path.join(run, 'failure.png') }).catch(() => {}); await writeFile(path.join(run, 'failure.txt'), String(e) + '\n' + await page.locator('body').innerText().catch(() => '')); } throw e; }
finally { await browser?.close(); app?.kill(); }
