// Local browser fixtures only; never sends real account credentials or model keys.
// Start Vite on port 1427, then run this script.
import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
const output = path.resolve('../../.tools/account-model-access-qa');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const root = process.env.MODEL_QA_URL || 'http://127.0.0.1:1427';
  let loginDestination = '';
  await page.route('https://organization.example/api/v1/auth/login', route => {
    loginDestination = route.request().url();
    expect(route.request().headers().authorization).toBeUndefined();
    return route.fulfill({ status: 401, json: { detail: '验证用账号，登录失败' } });
  });
  await page.route('https://provider.example/**', route => {
    if (route.request().url().endsWith('/models')) return route.abort('failed');
    return route.fulfill({ json: { choices: [{ message: { content: 'Direct fixture response' }, finish_reason: 'stop' }] } });
  });
  await page.goto(`${root}/login`);
  await page.getByRole('button', { name: '恢复默认', exact: true }).click();
  await expect(page.getByText('https://api.geiit.online/api/v1', { exact: true })).toBeVisible();
  await page.getByLabel('账号服务器地址').fill('https://organization.example');
  await page.getByRole('button', { name: '使用此地址' }).click();
  await expect(page.getByText('https://organization.example/api/v1', { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(output, 'login-server.png'), fullPage: true });
  await page.getByLabel('邮箱', { exact: true }).fill('fixture@example.com');
  await page.getByLabel('密码', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByText('验证用账号，登录失败', { exact: true })).toBeVisible();
  expect(loginDestination).toBe('https://organization.example/api/v1/auth/login');
  await page.getByRole('link', { name: '关闭登录并返回工作台' }).click();
  await expect(page).toHaveURL(/\/workbench$/);
  await page.getByLabel('解锁口令', { exact: true }).fill('fixture-password');
  await page.getByLabel('确认口令', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await page.getByRole('tab', { name: '模型', exact: true }).click();
  await expect(page.getByLabel('调用方式')).toHaveValue('direct');
  await page.getByLabel('连接名称', { exact: true }).fill('自购 API 验证');
  await page.getByLabel('API Base URL', { exact: true }).fill('https://provider.example/v1');
  await page.getByLabel('API Key', { exact: true }).fill('fixture-only-key');
  await page.getByLabel('模型名称', { exact: true }).fill('fixture-chat');
  await page.getByRole('button', { name: '获取模型列表', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('无法获取模型列表');
  await page.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('连接已加密保存到本机。');
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('模型文本调用成功');
  await page.route('https://provider.example/v1/models', async route => { await new Promise(resolve => setTimeout(resolve, 1500)); await route.abort().catch(() => {}); });
  await page.getByRole('button', { name: '获取模型列表', exact: true }).click();
  await expect(page.getByRole('progressbar', { name: '模型列表获取进度' })).toBeVisible();
  await page.screenshot({ path: path.join(output, 'model-list-progress.png'), fullPage: true });
  await page.getByRole('button', { name: '取消获取', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('请求已取消。');
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  await page.screenshot({ path: path.join(output, 'provider-direct.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${root}/login`);
  await page.screenshot({ path: path.join(output, 'login-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  console.log('PASS: login exit, visible account destination, guest direct API, list failure/cancellation, narrow layout. Fixture requests only.');
} finally { await browser.close(); }
