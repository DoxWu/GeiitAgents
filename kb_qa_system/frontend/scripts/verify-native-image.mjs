// Real packaged WebView2 -> Tauri ACL/IPC -> synthetic image API and URL download.
// Uses a fresh profile, never reads the user's vault, and kills only its own host.
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { parseArgs, parseEnv } from 'node:util';
import path from 'node:path';

const { values } = parseArgs({ options: {
  exe: { type: 'string', default: 'src-tauri/target-dev/release/geiit-workbench.exe' },
  output: { type: 'string', default: '../../.tools/native-image-20261102' },
  'expect-denied': { type: 'boolean', default: false },
  // Explicit opt-in only: one billed synthetic request, credentials stay in
  // memory and are never saved into the test vault, logs, images or reports.
  'provider-env': { type: 'string' },
} });
const root = path.resolve(values.output);
await mkdir(root, { recursive: true });
const output = await mkdtemp(path.join(root, 'run-'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
const requests = [], checks = [], errors = [];
let liveProvider;
const fixture = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  requests.push({ path: request.url, authorization: request.headers.authorization ?? null });
  if (request.url === '/image.png') {
    response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(png); return;
  }
  const body = JSON.parse(Buffer.concat(chunks).toString());
  expect(body.model).toBe('native-image-fixture');
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ data: [{ url: '/image.png' }] }));
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${fixture.address().port}/v1`;
const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const debugPort = probe.address().port; await new Promise(resolve => probe.close(resolve));
const exe = path.resolve(values.exe), binary = await readFile(exe);
let app, browser, page;
try {
  app = spawn(exe, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: path.join(output, 'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${debugPort}`,
  } });
  let launchError; app.on('error', error => { launchError = error; });
  await expect.poll(async () => {
    if (launchError) throw launchError;
    if (app.exitCode !== null) throw new Error('Native image QA host exited');
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, { timeout: 600 }); return true; }
    catch { return false; }
  }, { timeout: 30000 }).toBe(true);
  const context = browser.contexts()[0];
  await context.route('**/api/v1/**', route => route.fulfill({ json: route.request().url().includes('server-images') ? { models: [] } : { available: false } }));
  await context.routeWebSocket('**/ws/notifications', () => {});
  page = context.pages()[0] ?? await context.waitForEvent('page');
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.getByLabel('确认口令', { exact: true })).toBeVisible();
  const result = await page.evaluate(async ({ baseUrl }) => {
    try {
      const encoded = await window.__TAURI_INTERNALS__.invoke('generate_local_image', {
        requestId: crypto.randomUUID(), baseUrl, apiKey: 'synthetic-image-key', model: 'native-image-fixture', prompt: 'Synthetic image', direct: false,
      });
      return { ok: true, encoded };
    } catch (error) { return { ok: false, error: String(error) }; }
  }, { baseUrl });
  if (values['expect-denied']) {
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not allowed|denied|not permitted/i);
    expect(requests).toHaveLength(0);
    checks.push('old build rejects image command before any provider request');
  } else {
    expect(result.ok, result.error).toBe(true);
    expect(result.encoded).toBe(png.toString('base64'));
    expect(requests).toEqual([{ path: '/v1/images/generations', authorization: 'Bearer synthetic-image-key' }, { path: '/image.png', authorization: null }]);
    checks.push('native image command allowed and URL downloaded without API key');
    await page.getByLabel('解锁口令', { exact: true }).fill('synthetic-image-passphrase');
    await page.getByLabel('确认口令', { exact: true }).fill('synthetic-image-passphrase');
    await page.getByRole('button', { name: '创建', exact: true }).click();
    await page.getByRole('button', { name: '模型连接', exact: true }).click();
    await page.getByLabel('连接名称', { exact: true }).fill('原生生图验证');
    await page.getByLabel('调用方式').selectOption('local');
    await page.getByLabel('API Base URL').fill(baseUrl);
    await page.getByLabel('API Key', { exact: true }).fill('synthetic-image-key');
    await page.getByLabel('模型名称', { exact: true }).fill('native-chat-fixture');
    await page.getByLabel('生图模型（可选）', { exact: true }).fill('native-image-fixture');
    await page.getByRole('button', { name: '保存连接', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('连接已加密保存到本机。');
    await page.getByRole('tab', { name: '任务', exact: true }).click();
    await page.getByRole('tab', { name: '图片生成', exact: true }).click();
    await page.getByText('由模型生成图片', { exact: true }).click();
    await page.getByLabel('图片内容主题', { exact: true }).fill('Synthetic native UI image');
    await page.getByRole('button', { name: '生成图片并放入设计', exact: true }).click();
    await expect(page.getByRole('img', { name: '模型生成结果', exact: true })).toBeVisible({ timeout: 15000 });
    expect(await page.getByRole('img', { name: '模型生成结果', exact: true }).evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
    checks.push('actual image studio button generates and displays valid PNG');
    await page.screenshot({ path: path.join(output, 'native-image.png') });
    await page.evaluate(() => {
      const frame = document.createElement('iframe'); frame.id = 'image-qa-preview';
      frame.sandbox = 'allow-scripts'; frame.src = 'http://geiit-preview.localhost/web-preview.html'; document.body.append(frame);
    });
    const preview = page.frameLocator('#image-qa-preview');
    await expect(preview.locator('body')).toBeAttached();
    const denied = await preview.locator('body').evaluate(async () => {
      try {
        await window.__TAURI_INTERNALS__.invoke('generate_local_image', {}); return false;
      } catch (error) { return String(error).includes('unavailable in previews'); }
    });
    expect(denied).toBe(true);
    expect(requests).toHaveLength(4);
    checks.push('sandboxed preview still rejects native image commands');
    if (values['provider-env']) {
      const config = parseEnv(await readFile(path.resolve(values['provider-env']), 'utf8'));
      const connection = {
        baseUrl: config.MODEL_IMAGE_GENERATION_PRIMARY_API_URL,
        apiKey: config.MODEL_IMAGE_GENERATION_PRIMARY_API_KEY,
        model: config.MODEL_IMAGE_GENERATION_PRIMARY_MODEL,
      };
      if (!connection.baseUrl || !connection.apiKey || !connection.model) throw new Error('Primary image connection is incomplete in the specified env file');
      const result = await page.evaluate(async connection => {
        try {
          const encoded = await window.__TAURI_INTERNALS__.invoke('generate_local_image', {
            ...connection, requestId: crypto.randomUUID(), prompt: 'A simple blue circle on a plain white background, no text.', direct: true,
          });
          const binary = atob(encoded);
          return { ok: true, bytes: binary.length, png: binary.startsWith('\x89PNG\r\n\x1a\n') };
        } catch { return { ok: false }; }
      }, connection);
      expect(result.ok, 'Real provider native image request failed (credentials and provider details withheld)').toBe(true);
      expect(result.bytes).toBeGreaterThan(100);
      expect(result.png).toBe(true);
      liveProvider = { model: connection.model, requests: 1, bytes: result.bytes, png: result.png, imagesSaved: false, credentialsSaved: false };
      checks.push('real provider direct API via packaged WebView2 native image command');
    }
  }
  expect(errors).toEqual([]);
  const report = { passed: true, checks, syntheticHttpRequests: requests.length, liveProvider, errors,
    binary: { bytes: binary.length, sha256: createHash('sha256').update(binary).digest('hex') },
    baselineDenial: values['expect-denied'] ? result.error : undefined };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }));
} finally {
  await browser?.close().catch(() => {});
  if (app?.exitCode === null && app.pid) {
    const killer = spawn('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await once(killer, 'exit');
  }
  fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve));
}
