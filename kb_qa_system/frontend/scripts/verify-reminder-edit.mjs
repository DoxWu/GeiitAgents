// Production browser -> real FastAPI personal routes -> isolated SQLite memory.
// No real user tokens, production DB connections, Celery tasks, or email delivery.
// Start `vite preview --port 1425` first; backend test dependencies must be installed.
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createServer } from 'node:net';

const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const output = path.resolve('../../.tools/reminder-edit-qa'), backend = 'http://127.0.0.1:' + port;
await mkdir(output, { recursive: true });
const qaPythonPath = process.env.REMINDER_PYTHONPATH === 'none' ? '' : process.env.REMINDER_PYTHONPATH === undefined
  ? [path.resolve('../../.tools/python-ops'), process.env.PYTHONPATH || ''].filter(Boolean).join(path.delimiter)
  : process.env.REMINDER_PYTHONPATH;
const childEnv = { ...process.env, REMINDER_QA_PORT: String(port), DEBUG: 'true', DATABASE_URL: 'postgresql+psycopg://fixture@127.0.0.1:1/fixture' };
if (qaPythonPath) childEnv.PYTHONPATH = qaPythonPath; else delete childEnv.PYTHONPATH;
const service = spawn('python', ['-c', "import runpy; runpy.run_path('tests/reminder_qa_server.py', run_name='__main__')"], {
  cwd: path.resolve('../backend'), windowsHide: true,
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serviceOutput = ''; service.stdout.on('data', data => { serviceOutput += data; }); service.stderr.on('data', data => { serviceOutput += data; });
let browser, page;
const reminderResponses = [], reminderRequestFailures = [];
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
  page = await context.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    const url = new URL(response.url());
    if (/^\/api\/v1\/personal\/(capabilities|reminders(?:\/page)?)$/.test(url.pathname)) reminderResponses.push({ method: response.request().method(), path: url.pathname, status: response.status() });
  });
  page.on('requestfailed', request => {
    const url = new URL(request.url());
    if (/^\/api\/v1\/personal\/(capabilities|reminders(?:\/page)?)$/.test(url.pathname)) reminderRequestFailures.push({ method: request.method(), path: url.pathname, error: request.failure()?.errorText || 'request failed' });
  });
  const user = { id: 1, username: 'qa-user', email: 'qa@example.test', is_active: true, is_superuser: false, user_type: 'regular', created_at: '2026-01-01T00:00:00Z' };
  await context.addInitScript(user => {
    localStorage.setItem('kb_auth_tokens', JSON.stringify({ access_token: 'synthetic-fixture', refresh_token: 'synthetic-fixture', token_type: 'bearer' }));
    localStorage.setItem('kb_auth_user', JSON.stringify(user));
  }, user);
  let dropCreate = false, dropPatch = false, dropInitialList = true;
  const creates = [], patches = [], injectedFaults = [];
  await context.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/v1/personal/')) {
      const method = route.request().method(), creating = method === 'POST' && url.pathname.endsWith('/reminders'), patching = method === 'PATCH';
      if (creating) creates.push(route.request().postDataJSON());
      if (patching) patches.push(route.request().postDataJSON());
      const response = await route.fetch({ url: backend + url.pathname + url.search });
      if (!response.ok()) {
        let detail = 'non-JSON fixture response';
        try { detail = (await response.json()).detail ?? detail; } catch { /* Keep a safe default for HTML or proxy errors. */ }
        console.log(JSON.stringify({ failedFixturePath: url.pathname, status: response.status(), detail, fixtureLog: serviceOutput.slice(-2000) }));
      }
      if (method === 'GET' && url.pathname === '/api/v1/personal/reminders/page' && dropInitialList) {
        dropInitialList = false; injectedFaults.push('initial reminder list response dropped after successful fixture response');
        expect(response.status()).toBe(200); return route.abort('failed');
      }
      // Commit to the real isolated DB, then lose only the client response.
      if (creating && dropCreate) { dropCreate = false; expect(response.status()).toBe(201); return route.abort('failed'); }
      if (patching && dropPatch) { dropPatch = false; expect(response.status()).toBe(200); return route.abort('failed'); }
      return route.fulfill({ response });
    }
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
  await expect(page.getByLabel('提醒主题')).toBeEnabled();
  await expect(page.getByRole('alert')).toContainText('提醒列表查询失败');
  expect(injectedFaults).toHaveLength(1);
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
  const batch = await (await fetch(backend + '/__qa__/pagination', { method: 'POST' })).json();
  expect(batch.reminders).toBe(61);
  await page.getByRole('button', { name: '刷新邮件提醒' }).click();
  await expect(page.getByRole('article')).toHaveCount(20);
  const firstSubjects = await page.locator('article h3').allTextContents(), subjects = [...firstSubjects];
  const createdLater = await fetch(backend + '/api/v1/personal/reminders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request_id: crypto.randomUUID(), subject: '翻页期间新增', body: '刷新后可见', timezone: 'UTC', recurrence: 'once', next_run_at: '2099-03-01T09:00:00Z' }) });
  expect(createdLater.status).toBe(201);
  for (let index = 2; index <= 4; index++) {
    await page.getByRole('button', { name: '下一页提醒', exact: true }).click();
    await expect(page.getByRole('navigation', { name: '提醒分页' })).toContainText('第 ' + index + ' 页');
    subjects.push(...await page.locator('article h3').allTextContents());
    expect(await page.getByRole('article').count()).toBeLessThanOrEqual(20);
  }
  expect(subjects).toHaveLength(63); expect(new Set(subjects).size).toBe(63);
  expect(subjects).toContain('分页提醒 000'); expect(subjects).not.toContain('翻页期间新增');
  await expect(page.getByRole('button', { name: '下一页提醒' })).toBeDisabled();
  for (let index = 3; index >= 1; index--) {
    await page.getByRole('button', { name: '上一页提醒', exact: true }).click();
    await expect(page.getByRole('navigation', { name: '提醒分页' })).toContainText('第 ' + index + ' 页');
  }
  expect(await page.locator('article h3').allTextContents()).toEqual(firstSubjects);
  const pagedReminder = page.getByRole('article', { name: '提醒：分页提醒 060', exact: true });
  await pagedReminder.getByRole('button', { name: '投递记录', exact: true }).click();
  await expect(pagedReminder.getByRole('listitem')).toHaveCount(20);
  for (const [index, count] of [[2, 20], [3, 15]]) {
    await pagedReminder.getByRole('button', { name: '下一页投递', exact: true }).click();
    await expect(pagedReminder.getByRole('navigation', { name: '投递分页' })).toContainText('第 ' + index + ' 页');
    await expect(pagedReminder.getByRole('listitem')).toHaveCount(count);
  }
  await expect(pagedReminder.getByRole('button', { name: '下一页投递' })).toBeDisabled();
  await pagedReminder.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'pagination-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await pagedReminder.getByRole('navigation', { name: '投递分页' }).scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, 'mobile.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '刷新邮件提醒' }).click();
  await expect(page.getByRole('article', { name: '提醒：翻页期间新增' })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.getByText('提醒模板', { exact: true }).click();
  await page.getByLabel('选择提醒模板').selectOption('weekly-report');
  await page.getByRole('button', { name: '应用模板', exact: true }).click();
  await expect(page.getByLabel('提醒重复规则')).toHaveValue('weekly');
  await page.getByLabel('提醒主题').fill('跨刷新提醒草稿');
  await page.getByLabel('提醒内容').fill('本机加密恢复的合成内容。');
  await page.getByLabel('提醒时间').fill('2099-05-01T09:00');
  await page.getByLabel('新模板名称').fill('草稿验收模板');
  await page.getByRole('button', { name: '将当前内容保存为模板' }).click();
  await expect(page.getByLabel('选择提醒模板')).toContainText('草稿验收模板');
  await expect(page.getByLabel('提醒草稿保存状态')).toContainText('草稿已加密');
  const saved = await page.evaluate(() => localStorage.getItem('geiit.workbench.encrypted.v1'));
  expect(saved).not.toContain('跨刷新提醒草稿'); expect(saved).not.toContain('草稿验收模板');
  async function reload() {
    await page.reload();
    await page.getByLabel('解锁口令', { exact: true }).fill('reminder-qa-fixture');
    await page.getByRole('button', { name: '解锁', exact: true }).click();
    await page.getByRole('button', { name: '笔记与待办', exact: true }).click();
    await page.getByRole('button', { name: '邮件提醒', exact: true }).click();
    await expect(page.getByRole('button', { name: '刷新邮件提醒' })).toBeEnabled();
  }
  const originalCreates = creates.length;
  await reload();
  await expect(page.getByLabel('提醒主题')).toHaveValue('跨刷新提醒草稿');
  await expect(page.getByLabel('提醒时间')).toHaveValue('2099-05-01T09:00');
  expect(creates).toHaveLength(originalCreates);
  await page.getByText('提醒模板', { exact: true }).click();
  await expect(page.getByLabel('选择提醒模板')).toContainText('草稿验收模板');
  dropCreate = true;
  await expect(page.getByLabel('提醒内容')).toHaveValue('本机加密恢复的合成内容。');
  await expect(page.getByRole('button', { name: '保存提醒', exact: true })).toBeEnabled();
  await page.screenshot({ path: path.join(output, 'restored-draft.png'), fullPage: true });
  await page.getByRole('button', { name: '保存提醒', exact: true }).click();
  await expect(page.getByRole('region', { name: '待核查提交' })).toBeVisible();
  await expect(page.getByRole('alert')).toBeVisible();
  await reload();
  await expect(page.getByLabel('提醒内容')).toBeDisabled();
  await page.getByRole('button', { name: '核查上次提交' }).click();
  await expect(page.getByRole('status')).toContainText('未重复创建');
  expect(creates).toHaveLength(originalCreates + 1);
  const recovered = await (await fetch(backend + '/api/v1/personal/reminders/by-request/' + creates.at(-1).request_id)).json();
  await page.getByRole('article', { name: '提醒：跨刷新提醒草稿', exact: true }).getByRole('button', { name: '编辑 / 改期' }).click();
  await page.getByLabel('提醒内容').fill('已接受但响应丢失的修改。');
  dropPatch = true; const originalPatches = patches.length;
  await page.getByRole('button', { name: '保存修改' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await reload();
  await page.getByRole('button', { name: '核查上次提交' }).click();
  await expect(page.getByRole('status')).toContainText('当前内容与上次提交一致');
  expect(patches).toHaveLength(originalPatches + 1);
  const patched = await (await fetch(backend + '/api/v1/personal/reminders/' + recovered.id)).json();
  expect(patched.revision).toBe(2);
  await page.getByLabel('搜索提醒').fill('分页提醒');
  await page.getByLabel('筛选状态').selectOption('completed');
  await page.getByRole('button', { name: '搜索 / 筛选', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(20);
  await page.getByRole('button', { name: '下一页提醒', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '提醒分页' })).toContainText('第 2 页');
  expect((await page.locator('article h3').allTextContents()).every(subject => subject.startsWith('分页提醒'))).toBe(true);
  await page.screenshot({ path: path.join(output, 'drafts-search-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByLabel('搜索提醒').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'drafts-search-mobile.png') });
  expect(errors).toEqual([]);
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, backend: 'real FastAPI routes + isolated SQLite memory', deviceZone: 'America/Los_Angeles', reminderZone: 'Asia/Shanghai', checks: ['initial reminder-list response loss keeps create enabled when capabilities succeed', 'create', 'schedule and weekly rule edit', 'revision conflict retains draft', 'explicit latest reload', 'uncertain paused delivery dismissal', 'overdue reschedule and resume', '63 reminders across four pages, insertion boundary and return navigation', '55 deliveries across three pages', '390px layout'], injectedFaults, reminderResponses, reminderRequestFailures, emailsSent: 0, pageErrors: errors }, null, 2));
  await writeFile(path.join(output, 'drafts-result.json'), JSON.stringify({ passed: true, scope: 'Production browser / real isolated FastAPI and SQLite / no email sender', checks: ['encrypted draft and template reload', 'no auto submission', 'POST accepted then response lost recovered by request ID', 'PATCH accepted then response lost checked without replay', 'server search and filtered pagination', '390px'], emailsSent: 0 }));
  console.log('Reminder real HTTP editing/pagination plus encrypted drafts/templates, lost-response recovery, search and 390px QA passed.');
} catch (error) {
  console.log(JSON.stringify({ alerts: await page?.getByRole('alert').allTextContents().catch(() => []), statuses: await page?.getByRole('status').allTextContents().catch(() => []), disabledFields: await page?.locator('input, textarea, select, button').evaluateAll(nodes => nodes.filter(node => node.disabled).map(node => ({ tag: node.tagName, label: node.getAttribute('aria-label'), text: node.textContent?.trim().slice(0, 80) }))).catch(() => []), reminderResponses, reminderRequestFailures }));
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); throw error;
} finally { await browser?.close(); service.kill(); }
