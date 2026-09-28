// Real UI -> Web fetch or packaged Tauri/Rust -> loopback tool-protocol fixture.
// All task data and credentials are synthetic. Does not contact a real model.
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createSocket } from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';

const native = process.argv.includes('--native');
const output = path.resolve('../../.tools/office-tools-qa', native ? 'native' : 'web');
await mkdir(output, { recursive: true });
const calls = [], held = new Map(), protocolErrors = [];
const tool = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const service = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push(body);
    if (request.headers.authorization !== 'Bearer office-fixture-key') protocolErrors.push('Unexpected authorization');
    if (native && request.headers.origin) protocolErrors.push('Expected Rust transport');
    if (body.stream !== false || body.max_tokens !== undefined || body.tools?.length !== 3) protocolErrors.push('Invalid request shape');
    const task = JSON.parse(body.messages.find(message => message.role === 'user').content);
    const results = body.messages.filter(message => message.role === 'tool');
    let message;
    if (task.title === '未允许工具') message = { content: null, tool_calls: [tool('unknown', 'run_shell', {})] };
    else if (task.title !== '销售分析') {
      if (results.length) {
        const state = { response, closed: false }; held.set(task.title, state);
        response.on('close', () => { state.closed = true; }); return;
      }
      message = { content: null, tool_calls: [tool('partial', 'create_document', { title: '部分成果', markdown: '# 已生成部分\n\n中断前保存的合成内容。' })] };
    } else if (!results.length) message = { content: null, tool_calls: [tool('inspect1', 'inspect_csv', {})] };
    else if (results.length === 1) {
      const csv = JSON.parse(results[0].content);
      if (csv.headers[0] !== '月份' || csv.rows.length !== 3) protocolErrors.push('Missing actual CSV tool result');
      message = { content: null, tool_calls: [
        tool('chart1', 'render_chart', { title: '季度销量', category_column: 0, value_columns: [1, 2], chart_type: 'line', unit: '件' }),
        tool('doc1', 'create_document', { title: '季度报告', markdown: '# 季度报告\n\n甲产品由 10 件增长到 30 件。\n\n| 月份 | 甲 | 乙 |\n| --- | --- | --- |\n| 一月 | 10 | 8 |\n| 三月 | 30 | 18 |\n\n## 待确认\n\n- 数据为合成测试资料。' }),
      ] };
    } else {
      if (results.length !== 3 || results.some(result => !JSON.parse(result.content).ok)) protocolErrors.push('Missing tool outcomes');
      message = { content: '已生成季度销量图与报告，请核对合成资料。', tool_calls: [] };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message }] }));
  } catch { protocolErrors.push('Fixture request failed'); response.writeHead(500); response.end(); }
});
await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + service.address().port;
let app, browser, context, page;
try {
  if (native) {
    const profile = await mkdtemp(path.join(output, 'webview-'));
    const probe = createSocket(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    app = spawn(path.resolve('src-tauri/target-dev/release/geiit-workbench.exe'), [], { windowsHide: true, stdio: 'ignore', env: { ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: profile, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port,
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
    context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 950 } });
    page = await context.newPage();
    await page.goto(process.env.OFFICE_QA_URL || 'http://127.0.0.1:1423/workbench');
  }
  const errors = [], browserModelRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().startsWith(base)) browserModelRequests.push(request.url()); });
  await expect(page.getByRole('heading', { name: '创建本机密钥库' })).toBeVisible();
  await page.getByLabel('解锁口令', { exact: true }).fill('office-qa-passphrase');
  await page.getByLabel('确认口令', { exact: true }).fill('office-qa-passphrase');
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await page.getByLabel('连接名称', { exact: true }).fill('办公协议测试');
  await page.getByLabel('调用方式').selectOption('local');
  await page.getByLabel('API Base URL').fill(base + '/v1');
  await page.getByLabel('API Key', { exact: true }).fill('office-fixture-key');
  await page.getByLabel('模型名称', { exact: true }).fill('office-fixture');
  await page.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('连接已加密保存到本机。');
  async function openTasks() {
    await page.getByRole('tab', { name: '任务', exact: true }).click();
    await page.getByRole('tab', { name: '多步骤任务', exact: true }).click();
  }
  await openTasks();
  async function start(title) {
    await page.getByLabel('任务标题', { exact: true }).fill(title);
    await page.getByRole('textbox', { name: '办公目标', exact: true }).fill('读取 CSV，创建销售趋势图和 Markdown 报告。');
    await page.getByRole('button', { name: '开始多步骤任务', exact: true }).click();
  }
  await page.getByLabel('导入任务 CSV（最多 400 KB）').setInputFiles({ name: 'sales.csv', mimeType: 'text/csv', buffer: Buffer.from('月份,甲,乙\n一月,10,8\n二月,20,12\n三月,30,18') });
  await expect(page.getByRole('textbox', { name: '任务 CSV（可选）', exact: true })).toHaveValue(/三月,30,18/);
  await start('销售分析');
  const details = page.getByRole('region', { name: '多步骤任务详情', exact: true });
  await expect(details.getByRole('heading', { level: 2 })).toHaveText('销售分析 · 已完成', { timeout: 30000 });
  expect(calls).toHaveLength(3);
  await expect(page.getByLabel('选择成果')).toContainText('季度销量.svg');
  await expect(page.getByLabel('选择成果')).toContainText('季度报告.md');
  await expect(details.locator('ol > li')).toHaveCount(6);
  const image = page.getByRole('img', { name: '季度销量.svg' });
  await expect(image).toBeVisible();
  expect(await image.evaluate(element => element.complete && element.naturalWidth > 0)).toBe(true);
  async function download(name, fileName) {
    const event = page.waitForEvent('download'); await page.getByRole('button', { name, exact: true }).click();
    const file = await event; await file.saveAs(path.join(output, fileName));
    return readFile(path.join(output, fileName));
  }
  const svg = await download('下载成果', 'chart.svg'); expect(svg.toString()).toContain('<svg');
  await page.getByLabel('选择成果').selectOption({ label: '季度报告.md' });
  const md = await download('下载成果', 'report.md'); expect(md.toString()).toContain('甲产品由 10 件增长到 30 件');
  const docx = await download('导出 Word', 'report.docx');
  expect(await (await JSZip.loadAsync(docx)).file('word/document.xml').async('string')).toContain('季度报告');
  expect(calls).toHaveLength(3);
  await page.screenshot({ path: path.join(output, 'completed.png'), fullPage: true });

  await start('取消任务');
  await expect.poll(() => held.has('取消任务')).toBe(true);
  await page.getByRole('button', { name: '停止此任务' }).click();
  await expect(details.getByRole('heading', { level: 2 })).toHaveText('取消任务 · 已取消');
  await expect(details).toContainText('已保存 1 个成果');
  await expect.poll(() => held.get('取消任务').closed).toBe(true);
  await expect(page.getByRole('region', { name: '多步骤任务成果' })).toContainText('已生成部分');

  await start('锁库任务');
  await expect.poll(() => held.has('锁库任务')).toBe(true);
  await page.getByRole('button', { name: '锁定本机密钥库' }).click();
  await expect(page.getByRole('heading', { name: '解锁工作台' })).toBeVisible();
  await expect.poll(() => held.get('锁库任务').closed).toBe(true);
  const countBeforeReload = calls.length;
  await page.reload();
  await page.getByLabel('解锁口令', { exact: true }).fill('office-qa-passphrase');
  await page.getByRole('button', { name: '解锁', exact: true }).click();
  await openTasks();
  await expect(details.getByRole('heading', { level: 2 })).toHaveText('锁库任务 · 已中断');
  await expect(details).toContainText('已保存 1 个成果');
  expect(calls).toHaveLength(countBeforeReload);
  await page.getByRole('button', { name: '复用输入（新任务）' }).click();
  await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue('锁库任务');
  await start('未允许工具');
  await expect(details.getByRole('heading', { level: 2 })).toHaveText('未允许工具 · 失败');
  await expect(details).toContainText('已保存 0 个成果');
  const storage = await page.evaluate(() => JSON.stringify(localStorage));
  for (const sensitive of ['office-fixture-key', '季度报告', '三月,30,18']) expect(storage).not.toContain(sensitive);
  if (!native) {
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: path.join(output, 'narrow.png'), fullPage: true });
  } else expect(browserModelRequests).toEqual([]);
  expect(errors).toEqual([]); expect(protocolErrors).toEqual([]);
  const result = { passed: true, mode: native ? 'packaged WebView2 / Rust / HTTP fixture' : 'Chromium / real loopback HTTP fixture', requests: calls.length,
    checks: ['CSV result transcript', 'three model rounds', 'SVG and Markdown artifacts', 'DOCX export', 'encrypted checkpoints', 'cancel closes HTTP', 'lock/reload preserves partial artifacts', 'no replay', 'unknown tool rejected', 'reuse as new task', ...(native ? [] : ['390px'])] };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); throw error;
} finally {
  await browser?.close(); app?.kill(); service.closeAllConnections(); await new Promise(resolve => service.close(resolve));
}
