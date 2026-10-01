import { readVaultCiphertext } from './vault-qa.mjs';
// Production UI with real Chromium OPFS handles; no user files or native picker automation.
// Start `vite preview --port 1425` first. All fault injection uses synthetic files.
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

const output = path.resolve('../../.tools/file-organizer-qa');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 1000 } });
const page = await context.newPage(), errors = [], requests = [];
page.on('pageerror', error => errors.push(error.message));
context.on('request', request => requests.push(request.url()));
await context.route('**/api/v1/**', route => route.fulfill({ status: 200, json: {} }));
await context.routeWebSocket('**/ws/notifications', () => {});
await context.addInitScript(() => {
  window.organizerQaFailAfterFirstDelete = false;
  window.showDirectoryPicker = async () => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(window.organizerQaTarget ? 'organizer-qa-target' : 'organizer-qa-fixture', { create: true });
    let sourceDeletes = 0;
    return {
      name: directory.name,
      qaDirectory: directory,
      isSameEntry: other => directory.isSameEntry(other.qaDirectory),
      values: () => directory.values(),
      getFileHandle: (...args) => directory.getFileHandle(...args),
      removeEntry: async name => {
        if (window.organizerQaFailAfterFirstDelete && !name.startsWith('.geiit-stage-') && ++sourceDeletes === 2) {
          window.organizerQaFailAfterFirstDelete = false;
          throw new DOMException('Synthetic failure after one real OPFS source deletion', 'NotAllowedError');
        }
        return directory.removeEntry(name);
      },
    };
  };
});
async function files(target = false) {
  return page.evaluate(async target => {
    const root = await navigator.storage.getDirectory(), directory = await root.getDirectoryHandle(target ? 'organizer-qa-target' : 'organizer-qa-fixture');
    const result = {};
    for await (const [name, handle] of directory.entries()) result[name] = await (await handle.getFile()).text();
    return result;
  }, target);
}
async function openOrganizer(reload = false) {
  if (reload) {
    await page.reload(); await page.getByLabel('解锁口令', { exact: true }).fill('organizer-qa-fixture');
    await page.getByRole('button', { name: '解锁', exact: true }).click();
  }
  await page.getByRole('button', { name: '文件整理', exact: true }).click();
  await expect(page.getByRole('heading', { name: '本机整理历史' })).toBeVisible();
}
try {
  await page.goto(process.env.ORGANIZER_QA_URL || 'http://127.0.0.1:1425/workbench');
  await page.getByLabel('解锁口令', { exact: true }).fill('organizer-qa-fixture');
  await page.getByLabel('确认口令', { exact: true }).fill('organizer-qa-fixture');
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await openOrganizer();
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory(), directory = await root.getDirectoryHandle('organizer-qa-fixture', { create: true });
    for (const [name, text] of Object.entries({ 'a.txt': 'synthetic A 中文', 'b.md': '# synthetic B\ncontent' })) {
      const handle = await directory.getFileHandle(name, { create: true }), writer = await handle.createWritable();
      await writer.write(text); await writer.close();
    }
  });
  const before = await files(), requestCount = requests.filter(url => url.includes('/api/')).length;
  await page.getByRole('button', { name: '选择可整理目录' }).click();
  await expect(page.getByText('已选择 2 个文件', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '生成变更清单' }).click();
  await page.getByRole('button', { name: '应用可整理项目', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('整理已完成');
  const after = await files(); expect(Object.values(after).sort()).toEqual(Object.values(before).sort());
  expect(Object.keys(after).every(name => name.startsWith('归档_'))).toBe(true);
  await page.locator('summary').filter({ hasText: '已完成' }).click();
  const pendingDownload = page.waitForEvent('download'); await page.getByRole('button', { name: '导出记录', exact: true }).click();
  const download = await pendingDownload, record = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(record.changes).toHaveLength(2); expect(record.changes.every(item => /^[a-f0-9]{64}$/.test(item.sha256))).toBe(true);
  await download.saveAs(path.join(output, 'rename-record.json'));
  const encrypted = await readVaultCiphertext(page);
  expect(encrypted).not.toMatch(/organizer-qa-fixture|a\.txt|synthetic A|geiit-stage/);
  await page.screenshot({ path: path.join(output, 'desktop.png') });
  await openOrganizer(true);
  await page.locator('summary').filter({ hasText: '已完成' }).click();
  await expect(page.getByRole('button', { name: '预览撤销' })).toBeDisabled();
  await page.getByRole('button', { name: '选择可整理目录' }).click();
  await page.getByRole('button', { name: '预览撤销' }).click();
  expect(await files()).toEqual(after);
  await page.getByRole('button', { name: '确认撤销所选目录中的变更' }).click();
  await expect(page.getByRole('status')).toContainText('撤销已完成');
  expect(await files()).toEqual(before);
  await expect(page.locator('summary').filter({ hasText: '已撤销' })).toHaveCount(1);
  await page.evaluate(() => { window.organizerQaFailAfterFirstDelete = true; });
  await page.getByRole('button', { name: '生成变更清单' }).click();
  await page.getByRole('button', { name: '应用可整理项目', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('summary').filter({ hasText: '未应用或已回滚' })).toHaveCount(1);
  expect(await files()).toEqual(before);
  await page.locator('summary').filter({ hasText: '未应用或已回滚' }).click();
  const failed = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: '未应用或已回滚' }) });
  await failed.getByRole('button', { name: '核验目录', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('目录核验完成');
  expect(await files()).toEqual(before);
  await page.getByRole('button', { name: '重新读取目录' }).click();
  await page.getByRole('checkbox', { name: '移动到另一个目录', exact: true }).check();
  await page.evaluate(() => { window.organizerQaTarget = true; });
  await page.getByRole('button', { name: '选择目标目录', exact: true }).click();
  await expect(page.getByText('目标目录：organizer-qa-target', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '生成变更清单' }).click();
  await page.getByRole('button', { name: '应用可整理项目', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('整理已完成');
  expect(await files()).toEqual({}); expect(await files(true)).toEqual(before);
  const moved = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: 'organizer-qa-fixture → organizer-qa-target' }) });
  await moved.locator('summary').click(); await moved.getByRole('button', { name: '预览撤销' }).click();
  await page.getByRole('button', { name: '确认撤销所选目录中的变更' }).click();
  await expect(page.getByRole('status')).toContainText('撤销已完成');
  expect(await files()).toEqual(before); expect(await files(true)).toEqual({});
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('heading', { name: '本机整理历史' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'mobile.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(requests.filter(url => url.includes('/api/')).length).toBe(requestCount);
  expect(requests.some(url => /onnx|embedding|chat\/completions|private-models\/.*complete/.test(url))).toBe(false);
  expect(errors).toEqual([]);
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, filesystem: 'Chromium OPFS with injected directory picker', rename: true, encryptedReload: true, explicitUndo: true, crossDirectoryMoveAndUndo: true, realSourceDeletionCompensated: true, readOnlyInspection: true, mobileWidth: 390, pageErrors: errors }, null, 2));
  console.log('Real OPFS rename, encrypted reload, undo, failure compensation, inspection and 390px layout passed.');
} finally { await context.close(); await browser.close(); }
