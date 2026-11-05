// Isolated browser check. All model calls are intercepted synthetic responses.
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const baseUrl = process.env.WORKBENCH_UI_BASE_URL ?? 'http://127.0.0.1:1423';
const output = path.resolve('../../.tools/document-chart-ui-20261105');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [], sent = [], external = [], layouts = [];
page.on('pageerror', error => errors.push(error.message));
await page.routeWebSocket('**/ws/notifications', () => {});
await page.route('**/*', route => {
  const url = new URL(route.request().url());
  if (url.pathname === '/v1/chat/completions') {
    const body = route.request().postDataJSON(); sent.push(body);
    const image = body.messages.some(message => Array.isArray(message.content));
    const content = image ? JSON.stringify({ title: '图片识别销售额', chartType: 'line', unit: '万元', csv: '月份,销售额\n一月,20\n二月,35', categoryColumn: 0, valueColumns: [1], notes: ['合成识别草稿，数值需复核。'] }) : '# 合成项目报告\n\n## 本周进展\n\n已完成界面整理。';
    return route.fulfill({ json: { choices: [{ message: { content }, finish_reason: 'stop' }] } });
  }
  if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 503, json: { detail: 'Synthetic fixture: account services unavailable' } });
  if (url.origin !== new URL(baseUrl).origin) { external.push(url.origin); return route.abort(); }
  return route.continue();
});
async function layout(name) {
  for (const width of [1280, 390]) for (const dark of [false, true]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(value => document.documentElement.classList.toggle('dark', value), dark);
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    expect(fits).toBe(true); layouts.push({ name, width, dark, fits });
    if ((width === 1280 && !dark) || (width === 390 && dark)) await page.screenshot({ path: path.join(output, `${name}-${width}-${dark ? 'dark' : 'light'}.png`) });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}
try {
  await page.goto(new URL('/workbench', baseUrl).href);
  await page.getByLabel('解锁口令', { exact: true }).fill('synthetic-ui-passphrase');
  await page.getByLabel('确认口令', { exact: true }).fill('synthetic-ui-passphrase');
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await page.getByLabel('调用方式', { exact: true }).selectOption('local');
  await page.getByLabel('连接名称', { exact: true }).fill('合成视觉模型');
  await page.getByLabel('模型名称', { exact: true }).fill('synthetic-vision');
  await page.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('连接已加密保存');
  await page.getByRole('tab', { name: '任务', exact: true }).click();
  await layout('new-document');
  await page.getByLabel('文档标题', { exact: true }).fill('合成项目报告');
  await page.getByLabel('生成要求', { exact: true }).fill('整理进展');
  await page.getByRole('button', { name: '开始生成', exact: true }).click();
  await expect(page.getByRole('region', { name: '任务详情' })).toContainText('已完成');
  await expect(page.getByRole('button', { name: '开始生成', exact: true })).toHaveCount(0);
  await layout('document-history');
  await page.getByRole('button', { name: '复用输入新建', exact: true }).click();
  await expect(page.getByLabel('文档标题', { exact: true })).toHaveValue('合成项目报告');
  await expect(page.getByRole('region', { name: '任务详情' })).toHaveCount(0);
  await page.getByRole('button', { name: '新建文档任务', exact: true }).click();
  await expect(page.getByLabel('文档标题', { exact: true })).toHaveValue('');
  await page.getByLabel('输出文件类型', { exact: true }).selectOption('pptx');
  await expect(page.getByRole('region', { name: 'PPT 页面设计器' })).toBeVisible();
  await expect(page.getByLabel('设计与生成记录')).toHaveCount(0);
  await layout('ppt-editor');
  await page.getByRole('tab', { name: '图表工具', exact: true }).click();
  await page.getByText('从图表图片生成', { exact: true }).click();
  const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 500; canvas.height = 250; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 500, 250); ctx.fillStyle = '#187a72'; ctx.fillRect(60, 120, 80, 100); ctx.fillRect(240, 45, 80, 175); return canvas.toDataURL().split(',')[1]; });
  await page.getByLabel('选择图表图片文件').setInputFiles({ name: 'synthetic-chart.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.getByRole('button', { name: '识别并生成图表草稿', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('图片识别草稿');
  await expect(page.getByLabel('CSV 数据', { exact: true })).toHaveValue('月份,销售额\n一月,20\n二月,35');
  await expect(page.getByRole('img', { name: '预览：图片识别销售额', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '图表任务详情' })).toHaveCount(0);
  await layout('chart-image-draft');
  await page.getByRole('button', { name: '保存图表任务', exact: true }).click();
  await expect(page.getByRole('region', { name: '图表任务详情' })).toContainText('已完成');
  expect(sent).toHaveLength(2);
  expect(sent[1].messages[1].content[1].image_url.url).toContain('data:image/png;base64,');
  expect(errors).toEqual([]); expect(external).toEqual([]);
  const result = { passed: true, modelRequests: sent.length, providerRequests: 0, errors, external, layouts };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ errors, external, body: await page.locator('body').innerText() }, null, 2));
  throw error;
} finally { await browser.close(); }
