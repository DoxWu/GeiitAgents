// Synthetic local-only browser / packaged WebView2 QA. No real credentials or email.
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const native = process.argv.includes('--native');
const output = path.resolve('../../.tools/personal-items-qa', native ? 'native' : 'web');
await mkdir(output, { recursive: true });
async function unusedPort() {
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); return port;
}
let app, browser, context, page;
const errors = [], requests = [];
try {
  if (native) {
    const profile = await mkdtemp(path.join(output, 'webview-')), port = await unusedPort();
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
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    let url = process.env.PERSONAL_QA_URL;
    if (!url) {
      const port = await unusedPort(); url = `http://127.0.0.1:${port}/workbench`;
      app = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { windowsHide: true, stdio: 'ignore' });
      let launchError; app.on('error', error => { launchError = error; });
      await expect.poll(async () => { if (launchError) throw launchError; try { return (await fetch(url)).ok; } catch { return false; } }, { timeout: 15000 }).toBe(true);
    }
    await page.goto(url);
  }
  page.on('pageerror', error => errors.push(error.message));
  context.on('request', request => requests.push(request.url()));
  await context.route('**/api/v1/**', route => route.fulfill({ json: {} }));
  await context.routeWebSocket('**/ws/notifications', () => {});
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' });
  const button = name => page.getByRole('button', { name, exact: true });
  const title = page.getByLabel('标题', { exact: true }), content = page.getByLabel('笔记或待办内容');
  async function unlock(create = false) {
    await page.getByLabel('解锁口令', { exact: true }).fill('personal-test-1234');
    if (create) await page.getByLabel('确认口令', { exact: true }).fill('personal-test-1234');
    await button(create ? '创建' : '解锁').click();
    await button('笔记与待办').click();
    await expect(page.getByRole('region', { name: '笔记与待办' })).toBeVisible();
  }
  async function save() { await button('保存记录').click(); await expect(page.getByRole('status')).toHaveText('已保存到本机加密库。'); }
  async function download(name, filename) {
    const event = page.waitForEvent('download'); await button(name).click();
    const file = await event; await file.saveAs(path.join(output, filename)); return readFile(path.join(output, filename), 'utf8');
  }
  async function persisted() { await expect(page.getByLabel('本机编辑草稿保存状态')).toContainText('草稿已加密保存'); }
  await unlock(true);
  const apiBefore = requests.filter(url => url.includes('/api/')).length;
  await title.fill('提交季度工作报告'); await content.fill('确认数据后提交。\n\n- [ ] 复核附件');
  await page.getByLabel(/标签（/).fill('工作，报告'); await page.getByLabel('优先级', { exact: true }).selectOption('high');
  await page.getByLabel('截止时间', { exact: true }).fill('2020-01-01T09:30'); await save();
  await expect(page.getByRole('button', { name: /提交季度工作报告/ })).toContainText('已逾期');
  const markdown = await download('导出已保存记录', 'todo.md');
  expect(markdown).toContain('2020-01-01T01:30:00.000Z'); expect(markdown).toContain('复核附件');
  await page.getByLabel('待办筛选').selectOption('overdue');
  await page.getByLabel('状态', { exact: true }).selectOption('done'); await save();
  await expect(page.getByText('没有匹配记录')).toBeVisible();
  await page.getByLabel('待办筛选').selectOption('all');
  await button('笔记').click(); await title.fill('评审会议记录');
  const note = '# 会议结论\n\n**先核对数据**\n\n<script>alert(1)</script>\n\n![remote](https://example.test/not-requested.png)';
  await content.fill(note); await page.getByLabel(/标签（/).fill('会议，评审'); await save();
  await page.getByText('预览当前内容', { exact: true }).click();
  await expect(page.getByRole('heading', { name: '会议结论' })).toBeVisible();
  expect(await page.locator('section[aria-label="笔记与待办"] script').count()).toBe(0);
  await page.getByLabel('搜索笔记和待办').fill('评审'); await expect(button('评审会议记录')).toBeVisible();
  await page.getByLabel('搜索笔记和待办').fill('');
  // Multiple drafts survive record and module switches without discard dialogs.
  await title.fill('未保存的评审编辑'); await button('新建笔记').click();
  await content.fill('没有标题的未完成笔记'); await button('待办').click();
  await title.fill('固定时区草稿'); await page.getByLabel('截止时间', { exact: true }).fill('2030-02-01T09:30');
  await button('模型连接').click(); await button('笔记与待办').click();
  await expect(title).toHaveValue('固定时区草稿');
  await content.fill('输入后立即锁定也应保留'); await button('锁定本机密钥库').click(); await unlock();
  await expect(content).toHaveValue('输入后立即锁定也应保留');
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: '' });
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' });
  await page.reload(); await unlock();
  await expect(title).toHaveValue('固定时区草稿'); await expect(page.getByText('截止时间（Asia/Shanghai，可选）')).toBeVisible();
  await expect(page.getByLabel('截止时间', { exact: true })).toHaveValue('2030-02-01T09:30'); await save();
  expect(await download('导出已保存记录', 'timezone.md')).toContain('2030-02-01T01:30:00.000Z');
  // Record commits write the raw draft first. A failing final write keeps a
  // recoverable in-memory commit; retry must not repeat a revision increment.
  await content.fill('配额故障后的最终内容'); await persisted();
  await page.evaluate(() => {
    const original = Storage.prototype.setItem; let writes = 0;
    window.restorePersonalStorage = () => { Storage.prototype.setItem = original; };
    Storage.prototype.setItem = function (key, value) {
      if (key === 'geiit.workbench.encrypted.v1' && ++writes >= 2) throw new DOMException('fixture quota', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await button('保存记录').click(); await expect(page.getByText(/当前内存记录尚未确认保存/)).toBeVisible();
  await expect(button('保存记录')).toBeDisabled();
  await page.evaluate(() => window.restorePersonalStorage());
  await button('重试本机保存').click(); await expect(page.getByRole('status')).toHaveText('本机记录和草稿已重新保存。');
  await page.getByLabel('选择记录：固定时区草稿').check();
  const selected = JSON.parse(await download('批量导出 JSON', 'selected.json'));
  expect(selected.items).toHaveLength(1); expect(selected.items[0]).toMatchObject({ revision: 2, content: '配额故障后的最终内容' });
  expect(JSON.stringify(selected)).not.toContain('评审');
  await page.getByLabel('选择记录：提交季度工作报告').check();
  const batch = await download('批量导出 Markdown', 'selected.md');
  expect(batch).toContain('复核附件'); expect(batch).toContain('配额故障后的最终内容'); expect(batch).not.toContain('评审');
  await button('归档所选').click(); await expect(page.getByRole('status')).toHaveText('所选记录已归档。');
  await expect(page.getByText('没有匹配记录')).toBeVisible(); await expect(title).toBeDisabled();
  await page.getByLabel('归档筛选').selectOption('archived'); await button('选中筛选结果').click();
  const archived = JSON.parse(await download('批量导出 JSON', 'archived.json'));
  expect(archived.items).toHaveLength(2); expect(archived.items.every(item => item.archivedAt)).toBe(true);
  expect(archived.items.find(item => item.title === '提交季度工作报告').status).toBe('done');
  await button('恢复所选').click(); await expect(page.getByRole('status')).toHaveText('所选记录已恢复。');
  await page.getByLabel('归档筛选').selectOption('active');
  await button('选中筛选结果').click(); await page.getByLabel('搜索笔记和待办').fill('固定');
  await expect(button('批量导出 JSON')).toBeDisabled(); await page.getByLabel('搜索笔记和待办').fill('');
  await button('笔记').click(); await button('恢复草稿：未保存的评审编辑').click();
  await expect(title).toHaveValue('未保存的评审编辑'); await expect(content).toHaveValue(note);
  await page.getByLabel('选择记录：评审会议记录').check(); await button('归档所选').click();
  await expect(page.getByText('所选记录有未保存草稿，请先保存或丢弃草稿。')).toBeVisible();
  // Failed autosave keeps editor and in-memory draft intact until persistence retry.
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    window.restorePersonalStorage = () => { Storage.prototype.setItem = original; };
    Storage.prototype.setItem = function (key, value) {
      if (key === 'geiit.workbench.encrypted.v1') throw new DOMException('fixture quota', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await content.fill(note + '\n\n自动保存故障期间的输入');
  await expect(page.getByLabel('本机编辑草稿保存状态')).toContainText('尚未确认保存');
  await expect(content).toHaveValue(note + '\n\n自动保存故障期间的输入');
  await page.evaluate(() => window.restorePersonalStorage()); await button('重试本机保存').click();
  await expect(page.getByRole('status')).toHaveText('本机记录和草稿已重新保存。');
  const encrypted = await page.evaluate(() => localStorage.getItem('geiit.workbench.encrypted.v1'));
  expect(encrypted).not.toContain('评审'); expect(encrypted).not.toContain('故障期间');
  await page.screenshot({ path: path.join(output, 'desktop.png') });
  if (!native) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, 'mobile.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(title).toBeVisible(); await page.setViewportSize({ width: 1280, height: 900 });
  }
  await page.reload(); await unlock(); await expect(content).toHaveValue(note + '\n\n自动保存故障期间的输入');
  await button('恢复草稿：未命名').click(); await expect(title).toHaveValue(''); await expect(content).toHaveValue('没有标题的未完成笔记');
  await button('恢复草稿：未保存的评审编辑').click();
  page.once('dialog', dialog => dialog.accept()); await button('删除记录').click();
  await expect(page.getByRole('status')).toHaveText('已删除。'); await expect(button('保存记录')).toBeDisabled();
  await button('另存为新草稿').click(); await expect(page.getByRole('status')).toContainText('已复制为新草稿'); await save();
  await expect(content).toHaveValue(note + '\n\n自动保存故障期间的输入');
  expect(requests.filter(url => url.includes('/api/')).length).toBe(apiBefore);
  expect(requests.some(url => url.includes('example.test'))).toBe(false); expect(errors).toEqual([]);
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, native, checks: [
    'independent encrypted raw drafts', 'view switch, immediate lock and refresh recovery', 'fixed draft timezone across device timezone change',
    'UTC deadline, overdue and done', 'safe Markdown preview', 'revision-preserving final-write retry', 'autosave quota failure and retry',
    'selected Markdown/JSON download bytes', 'archive/restore and draft refusal', 'filter selection reset', 'delete and recover draft as new',
    ...(native ? [] : ['390px layout']), 'zero additional API/model requests',
  ], emailsSent: 0 }, null, 2));
  console.log(`Personal item ${native ? 'native' : 'browser'} verification passed. Output: ${output}`);
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ message: String(error), errors }, null, 2)); throw error;
} finally { await browser?.close(); app?.kill(); }
