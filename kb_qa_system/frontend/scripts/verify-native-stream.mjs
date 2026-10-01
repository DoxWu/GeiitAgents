// Default: packaged Tauri/WebView2 -> Rust IPC -> loopback model fixture.
// --web, --relay or --account: production browser; relay modes use real FastAPI
// routes + strict upstream transport with synthetic auth and a pinned loopback.
// Unique WebView data and debugger port; no real user profiles or model credentials.
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createSocket } from 'node:net';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';

const mode = process.argv.includes('--account') ? 'account' : process.argv.includes('--relay') ? 'relay' : process.argv.includes('--web') ? 'web' : 'native';
const output = path.resolve('../../.tools/model-stream-qa', mode);
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(output, 'webview-'));
const calls = [], streams = new Map(), timers = new Set(), protocolErrors = [];
const data = (content, finish) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content }, ...(finish ? { finish_reason: finish } : {}) }] }) + '\r\n\r\n';
const service = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString(), body = text ? JSON.parse(text) : null;
  const prompt = body?.messages?.at(-1)?.content;
  calls.push({ path: request.url, method: request.method, body });
  if (request.headers.authorization !== 'Bearer native-stream-fixture-key') protocolErrors.push('Unexpected fixture authorization');
  if (mode !== 'web' && request.headers.origin) protocolErrors.push('Unexpected browser model transport');
  if (request.url === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'native-chat' }, { id: 'embedding-only' }] })); return;
  }
  if (prompt === 'HTTP error') {
    response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'fixture-provider-secret' })); return;
  }
  if (!body?.stream || prompt === 'JSON fallback') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: prompt === 'JSON fallback' ? 'Fallback complete.' : 'OK' } }] })); return;
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' }); response.flushHeaders();
  const stream = { response, closed: false }; streams.set(prompt, stream);
  response.on('close', () => { stream.closed = true; });
  const first = data(prompt === 'Task A' ? '甲：你好🌏' : prompt === 'Task B' ? '乙：进行中' : '未完成片段');
  // Split within a UTF-8 scalar over separate HTTP writes.
  const bytes = Buffer.from(first), split = prompt === 'Task A' ? bytes.indexOf(Buffer.from('🌏')) + 1 : Math.floor(bytes.length / 2);
  response.write(bytes.subarray(0, split));
  const timer = setTimeout(() => { timers.delete(timer); response.write(bytes.subarray(split)); }, 20); timers.add(timer);
});
await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + service.address().port;
const portProbe = createSocket(); await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const debugPort = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
const executable = path.resolve(process.env.NATIVE_QA_EXE || 'src-tauri/target-dev/release/geiit-workbench.exe');
let app, backend, browser, page, launchError;
try {
  let context;
  if (mode === 'native') {
    app = spawn(executable, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: profile, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + debugPort,
    } });
    app.on('error', error => { launchError = error; });
  for (let attempt = 0; attempt < 60; attempt++) {
    if (launchError) throw launchError;
    if (app.exitCode !== null) throw new Error('Native QA app exited before debugger connection');
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + debugPort, { timeout: 700 }); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  if (!browser) throw new Error('Native WebView debugger unavailable');
  context = browser.contexts()[0];
  page = context.pages()[0] || await context.waitForEvent('page', { timeout: 10_000 });
  } else {
    app = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--configLoader', 'runner', '--host', '127.0.0.1', '--port', String(debugPort), '--strictPort'], { windowsHide: true, stdio: 'ignore' });
    app.on('error', error => { launchError = error; });
    const url = 'http://127.0.0.1:' + debugPort + '/workbench';
    await expect.poll(async () => { if (launchError) throw launchError; try { return (await fetch(url)).ok; } catch { return false; } }, { timeout: 15000 }).toBe(true);
    browser = await chromium.launch({ headless: true }); context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    if (mode === 'relay' || mode === 'account') {
      const probe = createSocket(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
      const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
      const backendUrl = 'http://127.0.0.1:' + port;
      backend = spawn('python', ['tests/model_stream_qa_server.py'], { cwd: path.resolve('../backend'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
        ...process.env, DEBUG: 'true', PYTHONPATH: [path.resolve('../backend'), path.resolve('../../.tools/python-tools-provider'), path.resolve('../../.tools/python-ops')].join(path.delimiter), MODEL_STREAM_QA_PORT: String(port), MODEL_STREAM_QA_UPSTREAM: base,
      } });
      let logs = ''; backend.stdout.on('data', data => { logs += data; }); backend.stderr.on('data', data => { logs += data; });
      await expect.poll(async () => { if (backend.exitCode !== null) throw new Error(logs); try { return (await fetch(backendUrl + '/healthz')).ok; } catch { return false; } }, { timeout: 15000 }).toBe(true);
      await context.route('**/api/v1/**', route => route.continue({ url: backendUrl + new URL(route.request().url()).pathname }));
      await context.routeWebSocket('**/ws/notifications', () => {});
      await context.addInitScript(() => {
        localStorage.setItem('kb_auth_tokens', JSON.stringify({ access_token: 'stream-account-fixture', refresh_token: 'fixture', token_type: 'bearer' }));
        localStorage.setItem('kb_auth_user', JSON.stringify({ id: 1, username: 'stream-qa', email: 'stream@example.test', is_active: true, is_superuser: false, user_type: 'regular' }));
      });
    }
    page = await context.newPage(); await page.goto(url);
  }
  const errors = [], browserModelRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().startsWith(base)) browserModelRequests.push(request.url()); });
  await expect(page.getByRole('heading', { name: '创建本机密钥库' })).toBeVisible();
  expect(await page.evaluate(() => '__TAURI_INTERNALS__' in window)).toBe(mode === 'native');
  await page.getByLabel('解锁口令', { exact: true }).fill('native-qa-passphrase');
  await page.getByLabel('确认口令', { exact: true }).fill('native-qa-passphrase');
  await page.getByRole('button', { name: '创建', exact: true }).click();
  if (mode !== 'account') {
  await page.getByRole('button', { name: '模型连接', exact: true }).click();
  await page.getByLabel('连接名称', { exact: true }).fill('原生流式测试');
  await page.getByLabel('调用方式').selectOption(mode === 'relay' ? 'relay' : 'local');
  await page.getByLabel('API Base URL').fill(mode === 'relay' ? 'https://models.example/v1' : base + '/v1');
  await page.getByLabel('API Key', { exact: true }).fill('native-stream-fixture-key');
  await page.getByRole('button', { name: '获取模型列表' }).click();
  await expect(page.getByLabel('从列表选择模型')).toBeVisible();
  await page.getByLabel('从列表选择模型').selectOption('native-chat');
  await page.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('连接已加密保存到本机。');
  await page.getByRole('button', { name: '测试连接' }).click();
  await expect(page.getByText('文本调用：本次测试已验证')).toBeVisible();
  }

  async function send(prompt) {
    await page.getByRole('button', { name: '新对话', exact: true }).click();
    if (mode === 'account') await page.getByLabel('当前对话模型').selectOption('$account');
    await page.getByRole('textbox', { name: '消息', exact: true }).fill(prompt);
    await page.getByRole('button', { name: '发送', exact: true }).click();
  }
  await send('Task A');
  await expect(page.getByRole('article', { name: '流式回答' })).toContainText('甲：你好🌏');
  await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(output, 'incremental-native.png') });
  await send('Task B');
  await expect(page.getByRole('article', { name: '流式回答' })).toContainText('乙：进行中');
  streams.get('Task A').response.end(data('，甲已完成。', 'stop'));
  await expect(page.getByText('甲：你好🌏，甲已完成。', { exact: true })).toHaveCount(0);
  streams.get('Task B').response.end(data('，乙已完成。') + 'data: [DONE]\r\n\r\n');
  await expect(page.getByText('乙：进行中，乙已完成。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Task A', exact: true }).click();
  await expect(page.getByText('甲：你好🌏，甲已完成。', { exact: true })).toBeVisible();
  await expect(page.getByLabel('模型停止原因')).toHaveText('模型已结束生成');
  await expect(page.getByRole('article', { name: '流式回答' })).toHaveCount(0);
  await page.screenshot({ path: path.join(output, 'completed-native.png') });

  await send('Cancel request');
  await expect(page.getByRole('article', { name: '流式回答' })).toContainText('未完成片段');
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('已停止');
  await expect.poll(() => streams.get('Cancel request').closed).toBe(true);
  await expect(page.getByText('未完成片段', { exact: true })).toHaveCount(0);

  await send('Truncated stream');
  await expect(page.getByRole('article', { name: '流式回答' })).toContainText('未完成片段');
  streams.get('Truncated stream').response.end();
  await expect(page.getByRole('alert')).toContainText('输出中断');
  await expect(page.getByText('未完成片段', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: path.join(output, 'truncated-native.png') });

  await send('JSON fallback');
  await expect(page.getByText('Fallback complete.', { exact: true })).toBeVisible();
  for (const [prompt, reason, label] of [['Length limit', 'length', '已达到模型输出上限'], ['Content restriction', 'content_filter', '输出受到模型服务限制']]) {
    await send(prompt); await expect(page.getByRole('article', { name: '流式回答' })).toContainText('未完成片段');
    streams.get(prompt).response.write(data('，结束说明。', reason));
    await expect(page.getByLabel('模型停止原因')).toContainText(label);
    await expect.poll(() => streams.get(prompt).closed).toBe(true); // Terminal without HTTP EOF must close upstream.
  }
  await send('HTTP error');
  await expect(page.getByRole('alert')).toContainText('请求失败');
  expect(await page.locator('body').innerText()).not.toContain('fixture-provider-secret');

  await send('Lock during stream');
  await expect(page.getByRole('article', { name: '流式回答' })).toContainText('未完成片段');
  await page.getByRole('button', { name: '锁定本机密钥库' }).click();
  await expect(page.getByRole('heading', { name: '解锁工作台' })).toBeVisible();
  await expect.poll(() => streams.get('Lock during stream').closed).toBe(true);
  await page.getByLabel('解锁口令', { exact: true }).fill('native-qa-passphrase');
  await page.getByRole('button', { name: '解锁', exact: true }).click();
  await page.getByRole('button', { name: 'Lock during stream', exact: true }).click();
  await expect(page.getByText('未完成片段', { exact: true })).toHaveCount(0);
  await page.reload();
  await page.getByLabel('解锁口令', { exact: true }).fill('native-qa-passphrase');
  await page.getByRole('button', { name: '解锁', exact: true }).click();
  await page.getByRole('button', { name: 'Task A', exact: true }).click();
  await expect(page.getByText('甲：你好🌏，甲已完成。', { exact: true })).toBeVisible();
  await expect(page.getByLabel('模型停止原因')).toHaveText('模型已结束生成');
  await page.getByRole('button', { name: 'Length limit', exact: true }).click();
  await expect(page.getByLabel('模型停止原因')).toContainText('已达到模型输出上限');
  const downloadEvent = page.waitForEvent('download'); await page.getByLabel('导出 Markdown').click();
  const download = await downloadEvent; await download.saveAs(path.join(output, 'length-answer.md'));
  const { readFile } = await import('node:fs/promises'); expect(await readFile(path.join(output, 'length-answer.md'), 'utf8')).toContain('回答可能不完整');
  if (mode !== 'native') { await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(output, 'mobile.png') }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.setViewportSize({ width: 1280, height: 900 }); }
  await page.getByRole('button', { name: 'Truncated stream', exact: true }).click();
  await expect(page.getByText('未完成片段', { exact: true })).toHaveCount(0);
  const storage = await page.evaluate(() => JSON.stringify(localStorage));
  expect(storage).not.toContain('native-stream-fixture-key'); expect(storage).not.toContain('甲：你好');
  expect(calls.filter(call => call.body?.stream === true)).toHaveLength(9);
  expect(calls.filter(call => call.body?.stream === false)).toHaveLength(mode === 'account' ? 0 : 1);
  for (const call of calls) { if (call.body) expect(call.body).not.toHaveProperty('max_tokens'); }
  if (mode !== 'web') expect(browserModelRequests).toEqual([]); else expect(browserModelRequests.length).toBeGreaterThan(8);
  expect(errors).toEqual([]); expect(protocolErrors).toEqual([]);
  const result = { passed: true, ...(mode === 'native' ? { executable } : {}), scope: mode === 'native' ? 'Packaged Tauri / WebView2 / Rust / loopback HTTP' : mode === 'web' ? 'Production Chromium / browser fetch / loopback HTTP' : 'Production Chromium / real FastAPI routes / selected strict HTTP transport / loopback fixture',
    mode, streamingRequests: 9, nonstreamTests: mode === 'account' ? 0 : 1, checks: ['incremental UTF-8', 'concurrent requests', 'cancel closes HTTP', 'lock closes HTTP', 'terminal markers', 'truncated failure not persisted', 'JSON fallback', 'provider error sanitized', 'encrypted reload', 'stop reason persistence and Markdown export', 'terminal closes live upstream'], errors };
  await writeFile(path.join(output, 'native-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser?.close(); app?.kill(); backend?.kill();
  for (const timer of timers) clearTimeout(timer);
  service.closeAllConnections(); await new Promise(resolve => service.close(resolve));
}
