// Production-browser QA with a synthetic local OpenAI-compatible model only.
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const output = path.resolve('../../.tools/chart-vision-qa');
await mkdir(output, { recursive: true });
const requests = [], server = createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    requests.push({ method: request.method, url: request.url, body: body ? JSON.parse(body) : null });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/chat/completions') response.end(JSON.stringify({ choices: [{ message: { content: '图例清晰；建议扩大长标签间距。' } }] }));
    else { response.statusCode = 404; response.end('{}'); }
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/v1/**', route => route.fulfill({ json: {} }));
  await page.routeWebSocket('**/ws/notifications', () => {});
  const url = process.env.CHART_VISION_QA_URL || 'http://127.0.0.1:1425/workbench';
  await page.goto(url);
  await page.getByLabel('解锁口令', { exact: true }).fill('chart-vision-fixture');
  await page.getByLabel('确认口令', { exact: true }).fill('chart-vision-fixture');
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await page.getByRole('tab', { name: '模型', exact: true }).click();
  await page.getByLabel('连接名称', { exact: true }).fill('本地图表审阅');
  await page.getByLabel('调用方式').selectOption('local');
  await page.getByLabel('API Base URL').fill(baseUrl);
  await page.getByLabel('模型名称', { exact: true }).fill('synthetic-vision');
  await page.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('连接已加密保存到本机。');
  await page.getByRole('tab', { name: '任务', exact: true }).click();
  await page.getByRole('tab', { name: '图表工具' }).click();
  await page.getByRole('button', { name: '检查并预览' }).click();
  await page.getByRole('button', { name: '保存图表任务' }).click();
  await expect(page.getByRole('status')).toContainText('图表和检查记录已保存');
  await page.getByRole('button', { name: '请求视觉审阅' }).click();
  await expect(page.getByRole('status')).toContainText('图表视觉审阅已加密保存');
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('POST'); expect(requests[0].url).toBe('/v1/chat/completions');
  expect(requests[0].body.model).toBe('synthetic-vision'); expect(requests[0].body).not.toHaveProperty('max_tokens');
  const content = requests[0].body.messages[0].content;
  expect(content).toHaveLength(2); expect(content[0].text).toContain('不要推断业务真实性');
  expect(content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
  const png = Buffer.from(content[1].image_url.url.split(',')[1], 'base64');
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(png.length).toBeLessThanOrEqual(1_500_000);
  await expect(page.getByText('图例清晰；建议扩大长标签间距。', { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(output, 'chart-review.png'), fullPage: true });
  const encrypted = await page.evaluate(() => localStorage.getItem('geiit.workbench.encrypted.v1'));
  expect(encrypted).not.toContain('图例清晰'); expect(encrypted).not.toContain(content[1].image_url.url);
  await page.reload();
  await page.getByLabel('解锁口令', { exact: true }).fill('chart-vision-fixture');
  await page.getByRole('button', { name: '解锁', exact: true }).click();
  await page.getByRole('tab', { name: '任务', exact: true }).click();
  await page.getByRole('tab', { name: '图表工具' }).click();
  await expect(page.getByText('图例清晰；建议扩大长标签间距。', { exact: true })).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(errors).toEqual([]);
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, localModelRequests: requests.length, pngBytes: png.length, reviewRestoredEncrypted: true, errors }, null, 2));
  console.log('Generated chart PNG was sent once to an explicit local model; encrypted review restored without request replay.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
