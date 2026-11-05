// Synthetic end-to-end SVG/GIF verification; no real provider requests.
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const output = path.resolve('../../.tools/image-formats-20261105');
await mkdir(output, { recursive: true });
const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { windowsHide: true, stdio: 'pipe' });
let logs = ''; server.stdout.on('data', chunk => { logs += chunk; }); server.stderr.on('data', chunk => { logs += chunk; });
const baseUrl = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = [], bodies = [], external = [], layouts = [], downloads = [];
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="80" fill="#204e48"/><circle cx="256" cy="256" r="130" fill="#eab86d"/><text x="256" y="280" text-anchor="middle" font-size="56">SVG</text></svg>');
const gif = Buffer.from('R0lGODlhYABAAIEAAOq4bSBOSAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAYABAAAAIwwADCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJsqXLlzBjypxJs6bNmzhz6tzJs6dMAECDAvCZUahRoEQpHl2KNOlDplCdNoRKVapCqlitIsRaVWtBrlm9DgTbVSzZsF7PltWqNqrZtkvFBoAb9y1doXLvGpU7V+9Qvn7/Ar7LdyzhwgLpIibYdvFXso4Poo0s+Sjly5gza97MubPnz6BDix5NurTp06hTq2YZEAAh+QQBCgACACwMABQAKQAZAIHquG0gTkgAAAAAAAAIlAAFCBw4MIDBgwEIKgTAsCEAhRAVIpxocKHDiw8jEqTIsSLGjww1CujYUQBIkBFJchx48qNElRMttnS4ESZCmTNDCrR5E2JOmiN5VvT5M6TQoRGLMjyaUKNSAExFPo3qVCnVpFaPSs0qdGvRoF2JfgXLE+tYsjZx5qwZlqXSl22fptQqVyPdsyJhqsUocm7MqhdFBgQAIfkEAQoAAgAsHAAUACkAGQCB6rhtIE5IAAAAAAAACJQABQgcODCAwYMBCCoEwLAhAIUQFSKcaHChw4sPIxKkyLEixo8MNQro2FEASJARSXIcePKjRJUTLbZ0uBEmQpkzQwq0eRNiTpojeVb0+TOk0KERizI8mlCjUgBMRT6N6lQp1aRWj0rNKnRr0aBdiX4FyxPrWLI2ceasGZal0pdtn6bUKlcj3bMiYarFKHJuzKoXRQYEACH5BAEKAAIALBwAFAApABkAgeq4bSBOSAAAAAAAAAiUAAUIHDgQgMGDAAgqDMCwYQCFEBUinGhwocOLDyMSpMixIsaPDDUK6NhRAEiQEUlyHHjyo0SVEy22dLgRJkKZM0MKtHkTYk6aI3lW9PkzpNChEYsyPJpQo9IATEU+jepUKdWkVo9KzSp0a9GgXYl+BcsT61iyNnHmrBmWpdKXbZ+m1CpXI92zImGqxShybsyqF0UGBAA7', 'base64');
page.on('pageerror', error => errors.push(error.message));
await page.routeWebSocket('**/ws/notifications', () => {});
await page.route('**/*', route => {
  const url = new URL(route.request().url());
  if (url.pathname === '/v1/images/generations') {
    const body = route.request().postDataJSON(); bodies.push(body);
    const content = body.output_format === 'svg' ? svg : gif;
    return route.fulfill({ json: { data: [{ b64_json: content.toString('base64') }] } });
  }
  if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 503, json: { detail: 'Synthetic account unavailable' } });
  if (url.origin !== baseUrl) { external.push(url.origin); return route.abort(); }
  return route.continue();
});
async function layout(format) {
  await page.getByLabel('\u751f\u6210\u683c\u5f0f', { exact: true }).scrollIntoViewIfNeeded();
  for (const width of [1280, 390]) for (const dark of [false, true]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(value => document.documentElement.classList.toggle('dark', value), dark);
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    expect(fits).toBe(true); layouts.push({ format, width, dark, fits });
    if (width === 1280 && !dark || width === 390 && dark) await page.screenshot({ path: path.join(output, `${format}-${width}-${dark ? 'dark' : 'light'}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 1000 });
}
async function download(format, content) {
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: '下载图片', exact: true }).click();
  const file = await pending, actual = await readFile(await file.path());
  expect(file.suggestedFilename()).toMatch(new RegExp(`\\.${format}$`));
  expect(actual.equals(content)).toBe(true); downloads.push({ format, bytes: actual.length, exact: true });
}
try {
  await expect.poll(async () => { try { return (await fetch(baseUrl)).status; } catch { return 0; } }, { timeout: 30000 }).toBe(200);
  await page.goto(`${baseUrl}/workbench`);
  await page.getByLabel('解锁口令', { exact: true }).fill('synthetic-formats-passphrase');
  await page.getByLabel('确认口令', { exact: true }).fill('synthetic-formats-passphrase');
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await page.getByLabel('调用方式', { exact: true }).selectOption('local');
  await page.getByLabel('连接名称', { exact: true }).fill('合成生图模型');
  await page.getByLabel('模型名称', { exact: true }).fill('synthetic-chat');
  await page.getByLabel('生图模型（可选）', { exact: true }).fill('gpt-image-2.6-flare');
  await page.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('连接已加密保存');
  await page.getByRole('tab', { name: '任务', exact: true }).click();
  await page.getByRole('tab', { name: '图片生成', exact: true }).click();
  await page.getByLabel('图片提示词', { exact: true }).fill('简洁的灯笼图标');
  await page.getByLabel('生成格式', { exact: true }).selectOption('svg');
  await page.getByText('由模型生成图片', { exact: true }).click();
  await page.getByRole('button', { name: '生成图片并放入设计', exact: true }).click();
  const result = page.getByRole('img', { name: '模型生成结果', exact: true });
  await expect(result).toBeVisible(); await expect.poll(() => result.evaluate(image => image.naturalWidth)).toBe(512);
  expect(bodies[0].output_format).toBe('svg'); expect(bodies[0]).not.toHaveProperty('frame_count'); expect(bodies[0]).not.toHaveProperty('response_format');
  await download('svg', svg); await layout('svg');
  await page.getByLabel('生成格式', { exact: true }).selectOption('gif');
  await page.getByLabel('动画模板', { exact: true }).selectOption({ label: '往返移动' });
  await page.getByLabel('动画帧数', { exact: true }).fill('12');
  await page.getByLabel('每帧毫秒', { exact: true }).fill('100');
  await page.getByText('实际发送的生图提示词（含当前构图）', { exact: true }).click();
  expect(await page.getByLabel('实际发送的生图提示词', { exact: true }).inputValue()).toContain('向右缓慢移动');
  await page.getByLabel('实际发送的生图提示词', { exact: true }).fill('User-edited final animation prompt');
  await page.getByRole('button', { name: '生成图片并放入设计', exact: true }).click();
  await expect(result).toHaveAttribute('src', /^data:image\/gif;base64,/); await expect.poll(() => result.evaluate(image => image.naturalWidth)).toBe(96);
  expect(bodies[1]).toMatchObject({ output_format: 'gif', size: 'auto', frame_count: 12, frame_duration_ms: 100, prompt: 'User-edited final animation prompt' });
  await download('gif', gif); await layout('gif');
  const taskId = await page.getByLabel('图片任务', { exact: true }).inputValue();
  await page.getByRole('button', { name: '新建图片任务', exact: true }).click();
  await expect(page.getByLabel('生成格式', { exact: true })).toHaveValue('png');
  await page.getByLabel('图片任务', { exact: true }).selectOption(taskId);
  await expect(page.getByLabel('生成格式', { exact: true })).toHaveValue('gif');
  await page.getByRole('button', { name: '锁定本机密钥库', exact: true }).click();
  await page.getByLabel('解锁口令', { exact: true }).fill('synthetic-formats-passphrase');
  await page.getByRole('button', { name: '解锁', exact: true }).click();
  await page.getByRole('tab', { name: '图片生成', exact: true }).click();
  await expect(page.getByLabel('生成格式', { exact: true })).toHaveValue('gif');
  await expect(result).toHaveAttribute('src', /^data:image\/gif;base64,/);
  await download('gif', gif);
  expect(errors).toEqual([]); expect(external).toEqual([]); expect(bodies).toHaveLength(2);
  const report = { passed: true, syntheticRequests: bodies.length, providerRequests: 0, layouts, downloads, errors, external };
  await writeFile(path.join(output, 'browser.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ errors, external, bodies, body: await page.locator('body').innerText(), logs }, null, 2));
  throw error;
} finally { await browser.close(); server.kill(); }
