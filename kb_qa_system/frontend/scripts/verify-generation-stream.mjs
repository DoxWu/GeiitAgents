// Real production UI and HTTP/Rust/relay generation; deterministic embedding
// fixture only. This does not measure E5 inference or DOCX page layout.
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { createServer as socket } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';

const mode = ['native', 'relay', 'account'].find(value => process.argv.includes('--' + value)) || 'web';
const output = path.resolve('../../.tools/generation-stream-qa', mode); await mkdir(output, { recursive: true });
const streams = new Map(), calls = [], errors = [], requests = [];
const event = data => 'data: ' + JSON.stringify(data) + '\n\n';
const contentEvent = content => event({ choices: [{ index: 0, delta: { content } }] });
const service = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*'); response.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()), input = JSON.parse(body.messages.at(-1).content), name = input.title || input.question;
    if (request.headers.authorization !== 'Bearer native-stream-fixture-key' || body.stream !== true || request.url !== '/v1/chat/completions' || 'max_tokens' in body) throw new Error('Unexpected synthetic request');
    calls.push({ name, body }); response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' }); response.flushHeaders();
    const stream = { response, closed: false }; streams.set(name, stream); response.on('close', () => { stream.closed = true; });
    const first = Buffer.from(contentEvent('# 增量中文🌏 ' + name)); const split = first.indexOf(Buffer.from('🌏')) + 1;
    response.write(first.subarray(0, split)); setTimeout(() => { if (!response.destroyed) response.write(first.subarray(split)); }, 20);
  } catch (error) { errors.push(String(error)); response.writeHead(500); response.end(); }
});
await new Promise(resolve => service.listen(0, '127.0.0.1', resolve)); const upstream = 'http://127.0.0.1:' + service.address().port;
async function unusedPort() { const probe = socket(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); return port; }
let app, backend, browser, context, page;
function mockEmbedding() {
  const Original = window.Worker; window.syntheticEmbeddingStarts = 0;
  window.Worker = class {
    constructor(url, options) {
      if (!String(url).includes('embedding.worker')) return new Original(url, options);
      window.syntheticEmbeddingStarts++; this.closed = false;
    }
    postMessage(request) {
      queueMicrotask(() => {
        if (this.closed) return;
        if (!['init', 'query'].includes(request.type)) throw new Error('Unexpected synthetic embedding operation');
        this.onmessage?.({ data: { id: request.id, type: 'result', result: request.type === 'query' ? Array.from({ length: 384 }, (_, i) => i === 0 ? 1 : 0) : null } });
      });
    }
    terminate() { this.closed = true; }
  };
}
try {
  const port = await unusedPort();
  if (mode === 'native') {
    const profile = await mkdtemp(path.join(output, 'webview-'));
    app = spawn(path.resolve('src-tauri/target-dev/release/geiit-workbench.exe'), [], { windowsHide: true, stdio: 'ignore', env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port } });
    let launchError; app.on('error', error => { launchError = error; });
    for (let attempt = 0; attempt < 60; attempt++) {
      if (launchError) throw launchError; if (app.exitCode !== null) throw new Error('Native app exited');
      try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 700 }); break; } catch { await new Promise(resolve => setTimeout(resolve, 200)); }
    }
    if (!browser) throw new Error('Native debugger unavailable'); context = browser.contexts()[0]; page = context.pages()[0] || await context.waitForEvent('page');
  } else {
    const url = 'http://127.0.0.1:' + port + '/workbench';
    app = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { windowsHide: true, stdio: 'ignore' });
    await expect.poll(async () => { try { return (await fetch(url)).ok; } catch { return false; } }, { timeout: 15000 }).toBe(true);
    browser = await chromium.launch({ headless: true }); context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
    if (['relay', 'account'].includes(mode)) {
      const apiPort = await unusedPort(), api = 'http://127.0.0.1:' + apiPort;
      backend = spawn('python', ['tests/model_stream_qa_server.py'], { cwd: path.resolve('../backend'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
        ...process.env, DEBUG: 'true', PYTHONPATH: [path.resolve('../backend'), path.resolve('../../.tools/python-tools-provider'), path.resolve('../../.tools/python-ops')].join(path.delimiter), MODEL_STREAM_QA_PORT: String(apiPort), MODEL_STREAM_QA_UPSTREAM: upstream,
      } });
      let logs = ''; backend.stdout.on('data', data => { logs += data; }); backend.stderr.on('data', data => { logs += data; });
      await expect.poll(async () => { if (backend.exitCode !== null) throw new Error(logs); try { return (await fetch(api + '/healthz')).ok; } catch { return false; } }, { timeout: 15000 }).toBe(true);
      await context.route('**/api/v1/**', route => route.continue({ url: api + new URL(route.request().url()).pathname }));
      await context.addInitScript(() => {
        localStorage.setItem('kb_auth_tokens', JSON.stringify({ access_token: 'stream-account-fixture', refresh_token: 'fixture' }));
        localStorage.setItem('kb_auth_user', JSON.stringify({ id: 1, username: 'stream-qa', email: 'stream@example.test', is_active: true, is_superuser: false, user_type: 'regular' }));
      });
    } else await context.route('**/api/v1/**', route => route.fulfill({ json: {} }));
    page = await context.newPage(); await page.goto(url);
  }
  page.on('pageerror', error => errors.push(error.message)); context.on('request', request => requests.push(request.url()));
  await context.routeWebSocket('**/ws/notifications', () => {}); await context.addInitScript(mockEmbedding); await page.evaluate(mockEmbedding);
  const button = name => page.getByRole('button', { name, exact: true }), field = name => page.getByLabel(name, { exact: true });
  async function unlock(create = false) { await field('解锁口令').fill('qa-generation-1234'); if (create) await field('确认口令').fill('qa-generation-1234'); await button(create ? '创建' : '解锁').click(); await expect(page.getByText('本机密钥库已解锁', { exact: true })).toBeVisible(); }
  async function finish(name, reason) { const stream = streams.get(name); stream.response.write(contentEvent('\n正文结尾 [1]')); stream.response.write(event({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })); await expect.poll(() => stream.closed).toBe(true); }
  async function download(name, filename) { const pending = page.waitForEvent('download'); await button(name).click(); const file = await pending; const target = path.join(output, filename); await file.saveAs(target); return readFile(target); }
  await unlock(true);
  if (mode !== 'account') {
    await button('模型连接').click(); await field('调用方式').selectOption(mode === 'relay' ? 'relay' : 'local'); await field('连接名称').fill('合成生成连接');
    await field('API Base URL').fill(mode === 'relay' ? 'https://models.example/v1' : upstream + '/v1'); await field('模型名称').fill('native-chat'); await field('API Key').fill('native-stream-fixture-key');
    await button('保存连接').click(); await expect(page.getByRole('status')).toHaveText('连接已加密保存到本机。');
  }
  async function documentTask(name) {
    await page.getByRole('tab', { name: '任务', exact: true }).click();
    if (mode === 'account') { if (await button('检查账号模型权限').isVisible()) await button('检查账号模型权限').click(); await field('文档生成模型').selectOption('$account'); }
    await field('文档标题').fill(name); await field('生成要求').fill('使用合成材料生成文档');
    if (['relay', 'account'].includes(mode)) { await expect(button('开始生成')).toBeDisabled(); await page.getByLabel(/我允许本次将文档标题/).check(); }
    await button('开始生成').click(); await expect(page.getByLabel('文档生成中的预览')).toContainText(name);
    await expect(page.getByLabel('文档成果')).toHaveCount(0);
  }
  await documentTask('Doc limit'); await page.getByLabel('文档生成中的预览').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, 'document-progress.png') }); await finish('Doc limit', 'length');
  await expect(page.getByLabel('文档生成状态')).toContainText('回答可能不完整');
  expect((await download('下载 Markdown', 'limited.md')).toString()).toContain('已达到模型输出上限');
  expect((await download('导出 HTML', 'limited.html')).toString()).toContain('已达到模型输出上限');
  const docx = await JSZip.loadAsync(await download('导出 DOCX', 'limited.docx'));
  expect(await docx.file('word/document.xml').async('string')).toContain('已达到模型输出上限'); // structure only, not pagination
  await documentTask('Doc truncated'); streams.get('Doc truncated').response.end(); await expect(page.getByRole('alert')).toContainText('中断'); await expect(page.getByLabel('文档成果')).toHaveCount(0);
  await documentTask('Doc stopped'); await button('停止').click(); await expect.poll(() => streams.get('Doc stopped').closed).toBe(true); await expect(page.getByLabel('文档生成中的预览')).toHaveCount(0);
  await documentTask('Doc locked'); await button('锁定本机密钥库').click(); await expect.poll(() => streams.get('Doc locked').closed).toBe(true); await unlock();
  await page.getByRole('button', { name: /Doc limit.*已完成/ }).click(); await expect(page.getByLabel('文档生成状态')).toContainText('回答可能不完整');
  await page.evaluate(async () => {
    const profile = { repo: 'Xenova/multilingual-e5-small', revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78', sha256: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193', dtype: 'q8', dimensions: 384, maxTokens: 512, pooling: 'mean', normalize: true, queryPrefix: 'query: ', passagePrefix: 'passage: ' };
    const text = '合成资料：报销需要发票。', index = { version: 1, revision: 'generation-qa', profile, fingerprint: JSON.stringify({ runtime: 'transformers-3.8.1-wasm', chunker: 'unicode-contiguous-v1', ...profile }), updatedAt: new Date().toISOString(), documents: [{ id: 'd1', name: '合成资料.md', text, bytes: new TextEncoder().encode(text).length }], chunks: [{ documentId: 'd1', start: 0, end: text.length, text, vector: Array.from({ length: 384 }, (_, i) => i === 0 ? 1 : 0) }] };
    await new Promise((resolve, reject) => { const r = indexedDB.open('geiit-local-knowledge-v1', 1); r.onupgradeneeded = () => r.result.createObjectStore('index'); r.onerror = reject; r.onsuccess = () => { const db = r.result, tx = db.transaction('index', 'readwrite'); tx.objectStore('index').put(index, 'active'); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = reject; }; });
  });
  await page.getByRole('link', { name: '本地知识库', exact: true }).click(); expect(await page.evaluate(() => window.syntheticEmbeddingStarts)).toBe(0);
  await button('启用模型 / 按配置重建').click(); await expect(button('选择文件并建立索引')).toBeEnabled();
  async function knowledge(name) {
    await field('本地检索问题').fill(name); await button('本地检索').click(); const answer = page.getByLabel('根据本地来源生成回答'); await expect(answer).toBeVisible();
    if (mode === 'account') { await answer.getByRole('button', { name: '检查账号云端模型权限' }).click(); await field('回答生成模型').selectOption('$account'); }
    else await field('回答生成模型').selectOption({ label: `合成生成连接 · ${mode === 'relay' ? '云端转发' : '本机接口'} · native-chat` });
    if (['relay', 'account'].includes(mode)) { await expect(button('根据所选来源生成回答')).toBeDisabled(); await page.getByLabel(/我允许本次将所选本地片段/).check(); }
    await button('根据所选来源生成回答').click(); await expect(page.getByLabel('本地知识库回答生成中的预览')).toContainText(name); await expect(button('保存为独立对话记录')).toHaveCount(0);
  }
  await knowledge('Knowledge filter'); await page.getByLabel('本地知识库回答生成中的预览').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, 'answer-progress.png') });
  if (mode === 'web') { await page.setViewportSize({ width: 390, height: 844 }); await page.getByLabel('本地知识库回答生成中的预览').scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: path.join(output, 'mobile.png') }); await page.setViewportSize({ width: 1280, height: 900 }); }
  await finish('Knowledge filter', 'content_filter'); await expect(page.getByLabel('回答生成状态')).toContainText('输出受到模型服务限制');
  expect((await download('导出回答 Markdown', 'answer.md')).toString()).toMatch(/输出受到模型服务限制[\s\S]*来源快照[\s\S]*合成资料/);
  await button('保存为独立对话记录').click(); await expect(button('已保存到工作台')).toBeDisabled();
  await knowledge('Knowledge truncated'); streams.get('Knowledge truncated').response.end(); await expect(page.getByRole('alert')).toContainText('中断'); await expect(button('导出回答 Markdown')).toHaveCount(0);
  await knowledge('Knowledge stopped'); await button('停止生成').click(); await expect.poll(() => streams.get('Knowledge stopped').closed).toBe(true); await expect(page.getByLabel('本地知识库回答生成中的预览')).toHaveCount(0);
  await knowledge('Knowledge unmounted'); await page.getByRole('link', { name: '工作台', exact: true }).click(); await expect.poll(() => streams.get('Knowledge unmounted').closed).toBe(true);
  await page.reload(); await unlock(); await expect(page.locator('main article')).toContainText('输出受到模型服务限制');
  expect(calls).toHaveLength(8); expect(calls.filter(c => c.name.startsWith('Knowledge')).every(c => JSON.parse(c.body.messages[1].content).sources.length === 1)).toBe(true);
  expect(errors).toEqual([]); expect(requests.filter(url => /huggingface|\.onnx(?:\?|$)/.test(url))).toEqual([]);
  if (mode === 'native') expect(requests.filter(url => url.startsWith(upstream))).toEqual([]);
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, mode, requests: calls.length, embedding: 'deterministic worker and seeded index; no E5 inference', docx: 'download bytes and XML annotation only; no page rendering', checks: ['incremental document and knowledge answer', 'strict EOF failure', 'stop, vault lock, view unmount close upstream', 'per-request cloud consent', 'metadata in downloads, encrypted save and reload', 'local/cloud index separation', 'zero auto model downloads'], errors }, null, 2));
  console.log(`Generation stream ${mode} QA passed: ${output}`);
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); await writeFile(path.join(output, 'failure.json'), JSON.stringify({ message: String(error), errors }, null, 2)); throw error;
} finally {
  for (const stream of streams.values()) stream.response.destroy(); await browser?.close(); app?.kill(); backend?.kill(); service.closeAllConnections(); await new Promise(resolve => service.close(resolve));
}
