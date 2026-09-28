// Production browser -> real FastAPI personal routes -> isolated SQLite memory.
// No real user tokens, production DB connections, Celery tasks, or email delivery.
// Start `vite preview --port 1425` first; backend test dependencies must be installed.
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const output = path.resolve('../../.tools/reminder-edit-qa'), backend = 'http://127.0.0.1:18763';
await mkdir(output, { recursive: true });
const service = spawn('python', ['-c', "import runpy; runpy.run_path('tests/reminder_qa_server.py', run_name='__main__')"], {
  cwd: path.resolve('../backend'), windowsHide: true,
  env: { ...process.env, DEBUG: 'true', DATABASE_URL: 'postgresql+psycopg://fixture@127.0.0.1:1/fixture', PYTHONPATH: [path.resolve('../../.tools/python-ops'), process.env.PYTHONPATH || ''].filter(Boolean).join(path.delimiter) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serviceOutput = ''; service.stdout.on('data', data => { serviceOutput += data; }); service.stderr.on('data', data => { serviceOutput += data; });
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (service.exitCode !== null) throw new Error('QA fixture exited: ' + serviceOutput.slice(-3000));
    try { const result = await fetch(backend + '/healthz'); if ((await result.json()).fixture === 'reminder-qa-memory-only') { ready = true; break; } } catch { /* Process starting. */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error('QA fixture did not start: ' + serviceOutput.slice(-3000));
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, timezoneId: 'America/Los_Angeles' });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const user = { id: 1, username: 'qa-user', email: 'qa@example.test', is_active: true, is_superuser: false, user_type: 'regular', created_at: '2026-01-01T00:00:00Z' };
  await context.addInitScript(user => {
    localStorage.setItem('kb_auth_tokens', JSON.stringify({ access_token: 'synthetic-fixture', refresh_token: 'synthetic-fixture', token_type: 'bearer' }));
    localStorage.setItem('kb_auth_user', JSON.stringify(user));
  }, user);
  await context.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/v1/personal/')) return route.fulfill({ response: await route.fetch({ url: backend + url.pathname + url.search }) });
    if (url.pathname.endsWith('/auth/me')) return route.fulfill({ json: user });
    return route.fulfill({ json: {} });
  });
  await context.routeWebSocket('**/ws/notifications', () => {});
  await page.goto(process.env.REMINDER_QA_URL || 'http://127.0.0.1:1425/workbench');
  await page.getByLabel('解锁口令', { exact: true }).fill('reminder-qa-fixture');
  await page.getByLabel('确认口令', { exact: true }).fill('reminder-qa-fixture');
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await page.getByRole('button', { name: '笔记与待办', exact: true }).click();
  await page.getByRole('button', { name: '邮件提醒', exact: true }).click();
  await page.getByLabel('提醒主题').fill('季度报告提醒');
  await page.getByLabel('提醒内容').fill('复核预算并提交报告。');
  await page.getByLabel('提醒时区').fill('Asia/Shanghai');
  await page.getByLabel('提醒时间').fill('2099-01-02T09:00');
  await page.getByRole('button', { name: '保存提醒', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已保存');
  const original = (await (await fetch(backend + '/api/v1/personal/reminders')).json())[0];
  expect(Date.parse(original.next_run_at)).toBe(Date.parse('2099-01-02T01:00:00Z'));
  await page.getByRole('button', { name: '编辑 / 改期', exact: true }).click();
  await expect(page.getByLabel('提醒时间')).toHaveValue('2099-01-02T09:00');
  await page.getByLabel('提醒时间').fill('2099-01-03T10:30');
  await page.getByLabel('提醒重复规则').selectOption('weekly');
  await page.getByRole('button', { name: '保存修改' }).click();
  await expect(page.getByRole('status')).toContainText('已修改');
  let current = await (await fetch(backend + '/api/v1/personal/reminders/' + original.id)).json();
  expect(current.revision).toBe(2); expect(current.recurrence).toBe('weekly');
  expect(Date.parse(current.next_run_at)).toBe(Date.parse('2099-01-03T02:30:00Z'));
  await page.getByRole('button', { name: '编辑 / 改期' }).click();
  await page.getByLabel('提醒内容').fill('我的未保存草稿');
  const concurrent = await fetch(backend + '/api/v1/personal/reminders/' + original.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: 2, body: '另一窗口的修改' }) });
  expect(concurrent.status).toBe(200);
  await page.getByRole('button', { name: '保存修改' }).click();
  await expect(page.getByRole('alert')).toContainText('最新版本');
  await expect(page.getByLabel('提醒内容')).toHaveValue('我的未保存草稿');
  await expect(page.getByRole('button', { name: '保存修改' })).toBeDisabled();
  await page.screenshot({ path: path.join(output, 'conflict-desktop.png') });
  await page.getByRole('button', { name: '载入最新版本（放弃草稿）' }).click();
  await expect(page.getByLabel('提醒内容')).toHaveValue('另一窗口的修改');
  await page.getByRole('button', { name: '退出编辑' }).click();
  const uncertain = await (await fetch(backend + '/__qa__/unknown', { method: 'POST' })).json();
  await page.getByRole('button', { name: '刷新邮件提醒' }).click();
  const article = page.getByRole('article', { name: '提醒：Uncertain fixture', exact: true });
  await article.getByRole('button', { name: '暂停', exact: true }).click();
  await article.getByRole('button', { name: '投递记录', exact: true }).click();
  await expect(article.getByRole('button', { name: '确认风险并重试' })).toHaveCount(0);
  page.once('dialog', dialog => dialog.accept());
  await article.getByRole('button', { name: '人工结束本次尝试' }).click();
  await expect(article.getByText('人工结束（可能已发送）', { exact: true })).toBeVisible();
  await article.getByRole('button', { name: '恢复', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '保存后恢复提醒' })).toBeChecked();
  await page.getByLabel('提醒时间').fill('2099-02-01T09:00');
  await page.getByRole('button', { name: '保存修改' }).click();
  await expect(page.getByRole('status')).toContainText('已修改');
  current = await (await fetch(backend + '/api/v1/personal/reminders/' + uncertain.id)).json();
  expect(current.status).toBe('active'); expect(current.revision).toBe(3);
  expect(Date.parse(current.next_run_at)).toBe(Date.parse('2099-02-01T01:00:00Z'));
  await page.setViewportSize({ width: 390, height: 844 });
  await article.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, 'mobile.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, backend: 'real FastAPI routes + isolated SQLite memory', deviceZone: 'America/Los_Angeles', reminderZone: 'Asia/Shanghai', checks: ['create', 'schedule and weekly rule edit', 'revision conflict retains draft', 'explicit latest reload', 'uncertain paused delivery dismissal', 'overdue reschedule and resume', '390px layout'], emailsSent: 0, pageErrors: errors }, null, 2));
  console.log('Reminder real HTTP create/edit/conflict/uncertain resolution/resume and 390px QA passed.');
} finally { await browser?.close(); service.kill(); }
