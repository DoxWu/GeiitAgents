// Real packaged WebView2 -> Tauri ACL/IPC -> synthetic image API and URL download.
// Uses a fresh profile, never reads the user's vault, and kills only its own host.
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { parseArgs, parseEnv } from 'node:util';
import path from 'node:path';
import { checkImageStudio } from './image-studio-checks.mjs';

const { values } = parseArgs({ options: {
  exe: { type: 'string', default: 'src-tauri/target-dev/release/geiit-workbench.exe' },
  output: { type: 'string', default: '../../.tools/native-image-20261102' },
  'expect-denied': { type: 'boolean', default: false },
  'large-4k': { type: 'boolean', default: false },
  // Explicit opt-in only: one billed synthetic request, credentials stay in
  // memory and are never saved into the test vault, logs, images or reports.
  'provider-env': { type: 'string' },
  'provider-reference-env': { type: 'string' },
} });
if (values['provider-env'] && values['provider-reference-env']) throw new Error('Select only one real provider test per run');
const root = path.resolve(values.output);
await mkdir(root, { recursive: true });
const output = await mkdtemp(path.join(root, 'run-'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const name = Buffer.from(type), checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  return Buffer.concat([size, name, data, checksum]);
}
function largeGeneratedPng(width, height) {
  const scanlines = Buffer.alloc((width * 3 + 1) * height); let state = 0x7f4a7c15;
  for (let y = 0; y < height; y++) for (let x = 0; x < width * 3; x++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    scanlines[y * (width * 3 + 1) + x + 1] = state & 255;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(scanlines)), pngChunk('IEND', Buffer.alloc(0))]);
}
const dimensions = values['large-4k'] ? [3840, 2160] : [1600, 1024];
const generatedPng = largeGeneratedPng(...dimensions);
if (generatedPng.length <= (values['large-4k'] ? 20 : 4) * 1024 * 1024 || generatedPng.length > 64 * 1024 * 1024) throw new Error('Synthetic large PNG fixture has an unexpected size');
const studioPng = values['large-4k'] ? generatedPng : largeGeneratedPng(1024, 1024);
if (studioPng.length <= 1_500_000 || studioPng.length > 64 * 1024 * 1024) throw new Error('Synthetic image-studio PNG fixture has an unexpected size');
const requests = [], bodies = [], checks = [], errors = [];
let liveProvider, imageDownload, useLargeGeneratedPng = true;
const fixture = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  requests.push({ path: request.url, authorization: request.headers.authorization ?? null });
  if (request.url === '/oversize.png') {
    response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(64 * 1024 * 1024 + 1) }); response.end(); return;
  }
  if (request.url === '/image.png') {
    response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(useLargeGeneratedPng ? generatedPng : studioPng); return;
  }
  let body;
  if (request.headers['content-type']?.startsWith('multipart/form-data')) {
    expect(request.url).toBe('/v1/images/edits');
    const form = await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': request.headers['content-type'] } }).formData();
    body = Object.fromEntries([...form.entries()].filter(([, value]) => typeof value === 'string'));
    const files = [...form.getAll('image'), ...form.getAll('image[]')];
    expect(files.length).toBeGreaterThan(0); expect(files.length).toBeLessThanOrEqual(2);
    for (const file of files) expect(Buffer.from(await file.arrayBuffer()).equals(png)).toBe(true);
    body.referenceCount = files.length;
  } else {
    expect(request.url).toBe('/v1/images/generations');
    body = JSON.parse(Buffer.concat(chunks).toString());
    body.referenceCount = 0;
  }
  bodies.push(body);
  expect(body.model).toBe('native-image-fixture');
  if (body.prompt.includes('OVERSIZE_RESULT')) {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: [{ url: '/oversize.png' }] })); return;
  }
  if (body.prompt.includes('INVALID_RESULT')) {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: [{ b64_json: Buffer.from('synthetic invalid image').toString('base64') }] })); return;
  }
  if (body.prompt.includes('UNSUPPORTED_REFERENCE')) { response.writeHead(404); response.end('synthetic unsupported'); return; }
  if (body.prompt.includes('DELAYED')) await new Promise(resolve => setTimeout(resolve, 1200));
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ data: [body.prompt.includes('INLINE_RESULT') ? { b64_json: generatedPng.toString('base64') } : { url: '/image.png' }] }));
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
      const header = Uint8Array.from(atob(encoded.slice(0, 32)), c => c.charCodeAt(0)), dimensions = new DataView(header.buffer);
      return { ok: true, bytes: encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0), width: dimensions.getUint32(16), height: dimensions.getUint32(20) };
    } catch (error) { return { ok: false, error: String(error) }; }
  }, { baseUrl });
  if (values['expect-denied']) {
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not allowed|denied|not permitted/i);
    expect(requests).toHaveLength(0);
    checks.push('old build rejects image command before any provider request');
  } else {
    expect(result.ok, result.error).toBe(true);
    expect(result.bytes).toBe(generatedPng.length);
    expect(result.bytes).toBeGreaterThan(4 * 1024 * 1024);
    expect([result.width, result.height]).toEqual(dimensions);
    expect(requests).toEqual([{ path: '/v1/images/generations', authorization: 'Bearer synthetic-image-key' }, { path: '/image.png', authorization: null }]);
    checks.push('native image command allowed and URL downloaded without API key');
    if (values['large-4k']) {
      const inlineBytes = await page.evaluate(async baseUrl => {
        const encoded = await window.__TAURI_INTERNALS__.invoke('generate_local_image', { requestId: crypto.randomUUID(), baseUrl, apiKey: 'synthetic-image-key', model: 'native-image-fixture', prompt: 'INLINE_RESULT 4K', size: '3840x2160' });
        return encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
      }, baseUrl);
      expect(inlineBytes).toBe(generatedPng.length);
      checks.push('native 4K inline Base64 above the previous 12 MiB response cap is received intact');
    }
    const prior = requests.length;
    const edit = await page.evaluate(async ({ baseUrl, reference }) => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const encoded = await invoke('generate_local_image', { requestId: crypto.randomUUID(), baseUrl, apiKey: 'synthetic-image-key', model: 'native-image-fixture', prompt: 'Edit two references', referenceImages: [reference, reference] });
      let error;
      try { await invoke('generate_local_image', { requestId: crypto.randomUUID(), baseUrl, apiKey: 'synthetic-image-key', model: 'native-image-fixture', prompt: 'UNSUPPORTED_REFERENCE', referenceImages: [reference] }); }
      catch (reason) { error = String(reason); }
      return { bytes: atob(encoded).length, error };
    }, { baseUrl, reference: `data:image/png;base64,${png.toString('base64')}` });
    expect(edit.bytes).toBe(generatedPng.length); expect(edit.error).toBe('IMAGE_REFERENCE_UNSUPPORTED');
    expect(requests.length - prior).toBe(3);
    checks.push('native multipart sends two original images; unsupported edit is explicit with no text retry');
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
    useLargeGeneratedPng = false;
    await page.getByRole('tab', { name: '任务', exact: true }).click();
    await page.getByRole('tab', { name: '图片生成', exact: true }).click();
    await page.getByText('由模型生成图片', { exact: true }).click();
    const studio = page.getByRole('region', { name: '图片生成工作室' });
    for (const [prompt, message] of [['OVERSIZE_RESULT', '64 MiB'], ['INVALID_RESULT', 'PNG']]) {
      await page.getByLabel('图片提示词', { exact: true }).fill(prompt);
      await page.getByRole('button', { name: '生成图片并放入设计', exact: true }).click();
      await expect(studio.getByRole('alert')).toContainText(message);
      await expect(studio.getByRole('img', { name: '模型生成结果', exact: true })).toHaveCount(0);
    }
    checks.push('native UI reports output size and invalid file errors explicitly without generic configuration advice');
    await page.getByLabel('图片提示词', { exact: true }).fill('Synthetic native UI image');
    if (values['large-4k']) await page.getByLabel('图片比例', { exact: true }).selectOption('3840x2160');
    await page.getByRole('button', { name: '生成图片并放入设计', exact: true }).click();
    await expect(page.getByRole('img', { name: '模型生成结果', exact: true })).toBeVisible({ timeout: 15000 });
    expect(await page.getByRole('img', { name: '模型生成结果', exact: true }).evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
    checks.push('actual image studio button generates and displays valid PNG');
    const downloadEvent = page.waitForEvent('download', { timeout: 10000 }).catch(error => error);
    await studio.getByText('下载图片', { exact: true }).click();
    const download = await downloadEvent;
    if (download instanceof Error) throw new Error('Generated-image download did not start after clicking 下载图片', { cause: download });
    expect(download.suggestedFilename()).toMatch(/\.png$/);
    const downloaded = await readFile(await download.path());
    expect(downloaded.equals(studioPng)).toBe(true);
    await expect(studio.getByRole('status')).toHaveText('图片下载已开始。');
    imageDownload = { filename: download.suggestedFilename(), bytes: downloaded.length, sha256: createHash('sha256').update(downloaded).digest('hex') };
    checks.push('actual generated-image download saves the complete original PNG with a matching filename');
    await checkImageStudio(page, output, bodies, png, checks, values['large-4k'] ? 3840 : 1024);
    const restoredDownloadEvent = page.waitForEvent('download', { timeout: 10000 });
    await studio.getByRole('button', { name: '下载图片', exact: true }).click();
    expect((await readFile(await (await restoredDownloadEvent).path())).equals(studioPng)).toBe(true);
    checks.push('download also works after task switching and encrypted reload without another image request');
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
    expect(requests.filter(request => request.path === '/image.png').every(request => request.authorization === null)).toBe(true);
    checks.push('sandboxed preview still rejects native image commands');
    if (values['provider-reference-env']) {
      const config = parseEnv(await readFile(path.resolve(values['provider-reference-env']), 'utf8'));
      const connection = { baseUrl: config.MODEL_IMAGE_GENERATION_PRIMARY_API_URL, apiKey: config.MODEL_IMAGE_GENERATION_PRIMARY_API_KEY, model: config.MODEL_IMAGE_GENERATION_PRIMARY_MODEL };
      if (!connection.baseUrl || !connection.apiKey || !connection.model) throw new Error('Primary image connection is incomplete');
      const result = await page.evaluate(async connection => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 512, 512); ctx.fillStyle = 'red'; ctx.fillRect(100, 100, 300, 300);
        const reference = canvas.toDataURL('image/png');
        try {
          const encoded = await window.__TAURI_INTERNALS__.invoke('generate_local_image', { ...connection, requestId: crypto.randomUUID(), prompt: 'Change the red square to blue. Preserve its shape, position and white background. No other objects.', size: '1024x1024', direct: true, referenceImages: [reference] });
          const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0)), dimensions = new DataView(bytes.buffer);
          return { ok: true, bytes: bytes.length, png: bytes[0] === 137 && bytes[1] === 80, width: dimensions.getUint32(16), height: dimensions.getUint32(20) };
        } catch (error) {
          return { ok: false, code: ['IMAGE_EDIT_QUOTA', 'IMAGE_AUTH_REJECTED', 'IMAGE_REFERENCE_UNSUPPORTED', 'IMAGE_RATE_LIMIT', 'IMAGE_RESULT_TOO_LARGE', 'IMAGE_RESULT_INVALID_FORMAT', 'IMAGE_RESULT_DOWNLOAD_FAILED', 'IMAGE_RESPONSE_TOO_LARGE'].includes(String(error)) ? String(error) : 'IMAGE_REQUEST_FAILED' };
        }
      }, connection);
      liveProvider = { kind: 'reference-image-edit', model: connection.model, requests: 1, referenceImages: 1, ...result, imagesSaved: false, credentialsSaved: false };
      if (result.ok) {
        expect(result.png).toBe(true); expect(result.bytes).toBeGreaterThan(100);
        checks.push('real provider returned PNG for a native reference-image edit');
      } else {
        // Report the block separately; passing synthetic checks do not imply
        // successful real-provider image editing.
        expect(result.code).toBe('IMAGE_EDIT_QUOTA');
      }
    }
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
            ...connection, requestId: crypto.randomUUID(), prompt: 'A simple small blue circle in the upper left on a plain white background, no text.', size: '1536x864', direct: true,
          });
          const binary = atob(encoded);
          const bytes = Uint8Array.from(binary, c => c.charCodeAt(0)), dimensions = new DataView(bytes.buffer);
          return { ok: true, bytes: binary.length, png: binary.startsWith('\x89PNG\r\n\x1a\n'), width: dimensions.getUint32(16), height: dimensions.getUint32(20) };
        } catch { return { ok: false }; }
      }, connection);
      expect(result.ok, 'Real provider native image request failed (credentials and provider details withheld)').toBe(true);
      expect(result.bytes).toBeGreaterThan(100);
      expect(result.png).toBe(true);
      expect([result.width, result.height]).toEqual([1536, 864]);
      liveProvider = { model: connection.model, requests: 1, bytes: result.bytes, png: result.png, width: result.width, height: result.height, imagesSaved: false, credentialsSaved: false };
      checks.push('real provider direct API via packaged WebView2 native image command');
    }
  }
  expect(errors).toEqual([]);
  const report = { passed: true, checks, syntheticHttpRequests: requests.length, liveProvider, imageDownload, errors,
    fixture: { dimensions, bytes: generatedPng.length, sha256: createHash('sha256').update(generatedPng).digest('hex') },
    binary: { bytes: binary.length, sha256: createHash('sha256').update(binary).digest('hex') },
    baselineDenial: values['expect-denied'] ? result.error : undefined };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }));
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  const images = await page?.getByRole('img', { name: '模型生成结果', exact: true }).evaluateAll(images => images.map(image => ({ width: image.naturalWidth, height: image.naturalHeight, complete: image.complete }))).catch(() => []);
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ checks, errors, images, syntheticHttpRequests: requests.length, error: String(error) }, null, 2));
  console.error(JSON.stringify({ output, passed: false, checks }));
  throw error;
} finally {
  await browser?.close().catch(() => {});
  if (app?.exitCode === null && app.pid) {
    const killer = spawn('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await once(killer, 'exit');
  }
  fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve));
}
