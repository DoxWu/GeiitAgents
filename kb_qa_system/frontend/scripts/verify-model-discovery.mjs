// Production Web -> real loopback HTTP provider fixture. Account/relay app APIs
// are stubbed in-browser; backend relay security is tested separately in pytest.
// Start vite preview on port 1425 before running. No real model keys or downloads.
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const output = path.resolve('../../.tools/model-discovery-qa');
await mkdir(output, { recursive: true });
const calls = [], timers = new Set();
const server = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString();
  calls.push({ path: request.url, method: request.method, hasKey: Boolean(request.headers.authorization), body: body ? JSON.parse(body) : null });
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/v1/models') response.end(JSON.stringify({ data: [{ id: 'local-chat', capabilities: ['vision'] }, { id: 'embedding-only' }, { id: 'local-chat' }] }));
  else if (request.url === '/v1/chat/completions') response.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
  else if (request.url === '/delayed/models') {
    const timer = setTimeout(() => { timers.delete(timer); response.end(JSON.stringify({ data: [{ id: 'late-result' }] })); }, 1000); timers.add(timer);
  } else { response.writeHead(404); response.end(JSON.stringify({ error: 'fixture-upstream-body-must-not-display' })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1050 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/api/v1/**', route => route.fulfill({ json: { available: false } }));
  await context.routeWebSocket('**/ws/notifications', () => {});
  await page.goto(process.env.MODEL_QA_URL || 'http://127.0.0.1:1425/workbench');
  await page.getByLabel('解锁口令', { exact: true }).fill('model-qa-passphrase');
  await page.getByLabel('确认口令', { exact: true }).fill('model-qa-passphrase');
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await page.getByLabel('连接名称', { exact: true }).fill('本机 QA');
  await page.getByLabel('调用方式').selectOption('local');
  await page.getByLabel('API Base URL').fill(base + '/v1');
  await page.getByLabel('API Key', { exact: true }).fill('model-discovery-fixture-key');
  await page.getByLabel('模型名称', { exact: true }).fill('manual-choice');
  expect(calls).toHaveLength(0);
  await page.getByRole('button', { name: '获取模型列表' }).click();
  await expect(page.getByLabel('从列表选择模型')).toBeVisible();
  await expect(page.getByLabel('模型名称', { exact: true })).toHaveValue('manual-choice');
  expect(calls).toEqual([{ path: '/v1/models', method: 'GET', hasKey: true, body: null }]);
  await expect(page.getByText('文本调用：未验证', { exact: true })).toBeVisible();
  await page.getByLabel('从列表选择模型').selectOption('local-chat');
  await page.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('连接已加密保存到本机。');
  await page.getByRole('button', { name: '测试连接' }).click();
  await expect(page.getByText(/^文本调用：最近测试通过/)).toBeVisible();
  expect(calls[1].body).not.toHaveProperty('max_tokens');
  expect(calls[1].body.model).toBe('local-chat');
  await page.reload();
  await page.getByLabel('解锁口令', { exact: true }).fill('model-qa-passphrase');
  await page.getByRole('button', { name: '解锁', exact: true }).click();
  await page.getByRole('tab', { name: '模型', exact: true }).click();
  await page.getByLabel('编辑 本机 QA').click();
  await expect(page.getByText(/^文本调用：最近测试通过/)).toBeVisible();
  const panel = page.getByRole('heading', { name: '模型连接', exact: true }).locator('../..');
  await panel.evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: path.join(output, 'local-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: path.join(output, 'local-mobile.png'), fullPage: true });
  await page.getByText(/^文本调用：最近测试通过/).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'local-mobile-capabilities.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.getByLabel('API Base URL').fill(base + '/other');
  await page.getByRole('button', { name: '获取模型列表' }).click();
  await expect(page.getByRole('status')).toContainText('重新填写');
  expect(calls).toHaveLength(2);
  await page.getByLabel('API Key', { exact: true }).fill('replacement-fixture-key');
  await page.getByRole('button', { name: '获取模型列表' }).click();
  await expect(page.getByRole('status')).toContainText('可继续手填');
  await expect(page.getByLabel('模型名称', { exact: true })).toHaveValue('local-chat');
  expect(await page.locator('body').innerText()).not.toContain('fixture-upstream-body');
  await page.getByLabel('API Base URL').fill(base + '/delayed');
  await page.getByRole('button', { name: '获取模型列表' }).click();
  await expect.poll(() => calls.filter(call => call.path === '/delayed/models').length).toBe(1);
  await page.getByRole('button', { name: '取消请求' }).click();
  await expect(page.getByRole('status')).toHaveText('请求已取消。');
  await page.waitForTimeout(1200); // Allow the deliberately late fixture response to arrive.
  await expect(page.getByLabel('从列表选择模型')).toHaveCount(0);
  const storage = await page.evaluate(() => JSON.stringify(localStorage));
  expect(storage).not.toContain('model-discovery-fixture-key');
  expect(storage).not.toContain('replacement-fixture-key');

  const accountContext = await browser.newContext({ viewport: { width: 1280, height: 1050 } });
  const user = { id: 42, username: 'fixture', email: 'fixture@example.test', is_active: true, is_superuser: false, user_type: 'regular', created_at: '' };
  await accountContext.addInitScript(user => {
    localStorage.setItem('kb_auth_tokens', JSON.stringify({ access_token: 'synthetic-account-token' }));
    localStorage.setItem('kb_auth_user', JSON.stringify(user));
  }, user);
  const relayBodies = [];
  await accountContext.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/private-models/models')) {
      relayBodies.push(route.request().postDataJSON());
      expect(route.request().headers()['x-model-api-key']).toBe('relay-fixture-key');
      return route.fulfill({ json: { models: [{ id: 'relay-chat' }], truncated: true } });
    }
    if (url.pathname.endsWith('/private-models/account')) return route.fulfill({ json: { available: true, model: 'account-approved' } });
    return route.fulfill({ json: url.pathname.endsWith('/auth/me') ? user : {} });
  });
  await accountContext.routeWebSocket('**/ws/notifications', () => {});
  const accountPage = await accountContext.newPage();
  accountPage.on('pageerror', error => errors.push(error.message));
  await accountPage.goto(process.env.MODEL_QA_URL || 'http://127.0.0.1:1425/workbench');
  await accountPage.getByLabel('解锁口令', { exact: true }).fill('model-qa-passphrase');
  await accountPage.getByLabel('确认口令', { exact: true }).fill('model-qa-passphrase');
  await accountPage.getByRole('button', { name: '创建', exact: true }).click();
  await accountPage.getByRole('tab', { name: '模型', exact: true }).click();
  await expect(accountPage.getByText('已授权：account-approved')).toBeVisible();
  await accountPage.getByLabel('API Base URL').fill('https://models.example/v1');
  await accountPage.getByLabel('API Key', { exact: true }).fill('relay-fixture-key');
  await accountPage.getByRole('button', { name: '获取模型列表' }).click();
  await expect(accountPage.getByLabel('从列表选择模型')).toBeVisible();
  expect(relayBodies).toEqual([{ base_url: 'https://models.example/v1' }]);
  await expect(accountPage.getByText(/仅展示部分有效模型/)).toBeVisible();
  await accountPage.getByRole('heading', { name: '模型连接', exact: true }).locator('../..').evaluate(element => { element.scrollTop = 0; });
  await accountPage.screenshot({ path: path.join(output, 'relay-account-desktop.png'), fullPage: true });
  expect(errors).toEqual([]);
  const result = { passed: true, localHttpCalls: calls.length, relayAppApi: 'browser stub', accountAppApi: 'browser stub', screenshots: output, errors };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  for (const timer of timers) clearTimeout(timer);
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
