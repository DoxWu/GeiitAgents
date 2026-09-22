// Browser integration for encrypted office TaskRun/ToolRun/Artifact. Uses only synthetic fixtures and mocked generation.
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const output = path.resolve('../../.tools/document-task-qa');
const liveProvider = process.env.DOCUMENT_TASK_LIVE === '1';
await mkdir(output, { recursive: true });
const context = await chromium.launchPersistentContext(path.join(output, 'browser-profile'), { headless: true, acceptDownloads: true, viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
for (const old of context.pages()) if (old !== page) await old.close();
const requests = [], sent = [], errors = [];
let releaseSecond;
async function live(messages) {
  return new Promise((resolve, reject) => {
    const child = spawn('python', [path.resolve('../backend/scripts/verify_local_answer_live.py')], { windowsHide: true,
      env: { ...process.env, DEBUG: 'true', PYTHONIOENCODING: 'utf-8', PYTHONPATH: path.resolve('../../.tools/python-ops') }, stdio: ['pipe', 'pipe', 'ignore'] });
    let outputText = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Live provider timed out')); }, 130000);
    child.stdout.on('data', data => { outputText += data.toString(); if (outputText.length > 1_500_000) child.kill(); });
    child.on('error', () => { clearTimeout(timer); reject(new Error('Live helper could not start')); });
    child.on('exit', code => {
      clearTimeout(timer);
      try { const result = JSON.parse(outputText); if (code !== 0 || !result.content) throw new Error(); resolve(result); }
      catch { reject(new Error('Live provider failed; sensitive response suppressed')); }
    });
    child.stdin.end(JSON.stringify({ fixture: 'geiit-local-answer-qa', messages }));
  });
}
context.on('request', request => requests.push(request.url()));
page.on('pageerror', error => errors.push(error.message));
await context.routeWebSocket('**/ws/notifications', () => {});
await context.route('**/api/v1/**', async route => {
  const endpoint = new URL(route.request().url()).pathname;
  if (endpoint.endsWith('/private-models/account')) return route.fulfill({ json: { available: true, model: 'fixture-document-model' } });
  if (endpoint.endsWith('/private-models/account/complete')) {
    const body = route.request().postDataJSON();
    sent.push(body);
    const completions = requests.filter(url => url.includes('/private-models/account/complete')).length;
    if (completions > 1) await new Promise(resolve => { releaseSecond = resolve; });
    const result = liveProvider && completions === 1 ? await live(body.messages) : { model: 'fixture-document-model', content: '```markdown\n# 项目周报\n\n## 进展\n\n登录模块已完成。\n\n## 风险\n\n- 安全评审待完成\n```' };
    try { return await route.fulfill({ json: result }); }
    catch { return; }
  }
  return route.fulfill({ status: 200, json: {} });
});
try {
  await page.goto('http://127.0.0.1:1423/workbench');
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('kb_auth_tokens', JSON.stringify({ access_token: 'synthetic-task-session', refresh_token: 'synthetic-task-session' }));
    localStorage.setItem('kb_auth_user', JSON.stringify({ id: 202, username: 'task-fixture', email: 'task@example.test', is_active: true, is_superuser: false, user_type: 'regular', created_at: '' }));
  });
  await page.reload();
  await page.getByLabel('解锁口令', { exact: true }).fill('task-test-1234');
  await page.getByLabel('确认口令', { exact: true }).fill('task-test-1234');
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await page.getByRole('tab', { name: '任务' }).click();
  await expect(page.getByLabel('文档生成模型')).toContainText('fixture-document-model');
  await page.getByLabel('文档标题', { exact: true }).fill('项目周报');
  await page.getByLabel('生成要求', { exact: true }).fill('整理为包含进展、风险和下周计划的周报。');
  await page.getByLabel('参考材料（可选）', { exact: true }).fill('登录模块已完成，等待安全评审。');
  const start = page.getByRole('button', { name: '开始生成' });
  await expect(start).toBeDisabled();
  await page.getByLabel(/我允许本次/).check(); await start.click();
  await expect(page.getByRole('region', { name: '任务详情' })).toContainText('已完成', { timeout: liveProvider ? 130000 : 30000 });
  await expect(page.getByRole('button', { name: '下载 Markdown' })).toBeVisible();
  if (!liveProvider) await expect(page.getByRole('region', { name: '任务详情' })).toContainText('登录模块已完成');
  const completionRequests = requests.filter(url => url.includes('/private-models/account/complete'));
  expect(completionRequests).toHaveLength(1);
  const firstPayload = JSON.parse(sent[0].messages[1].content);
  expect(firstPayload).toEqual({ title: '项目周报', instruction: '整理为包含进展、风险和下周计划的周报。',
    source: { file: '粘贴材料.txt', content: '登录模块已完成，等待安全评审。' } });
  expect(JSON.stringify(sent[0])).not.toMatch(/synthetic-task-session|task-test-1234|api.?key/i);
  const encrypted = await page.evaluate(() => localStorage.getItem('geiit.workbench.encrypted.v1'));
  expect(encrypted).not.toContain('登录模块'); expect(encrypted).not.toContain('项目周报');
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 Markdown' }).click();
  const downloaded = await downloadEvent, markdown = await readFile(await downloaded.path(), 'utf8');
  expect(markdown.length).toBeGreaterThan(30); expect(markdown).not.toMatch(/^```(?:markdown|md)/i);
  if (!liveProvider) { expect(markdown).toContain('# 项目周报'); expect(markdown).toContain('安全评审待完成'); }
  await page.screenshot({ path: path.join(output, 'completed-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, 'completed-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.reload();
  await page.getByLabel('解锁口令', { exact: true }).fill('task-test-1234');
  await page.getByRole('button', { name: '解锁', exact: true }).click();
  await page.getByRole('tab', { name: '任务' }).click();
  await expect(page.getByRole('region', { name: '任务详情' })).toContainText('项目周报');
  await expect(page.getByRole('button', { name: '下载 Markdown' })).toBeVisible();
  await page.getByLabel('文档标题', { exact: true }).fill('取消测试');
  await page.getByLabel('生成要求', { exact: true }).fill('生成一份不会被保存的测试文档。');
  await page.getByLabel('参考材料（可选）', { exact: true }).fill('仅用于取消流程。');
  await page.getByLabel(/我允许本次/).check(); await page.getByRole('button', { name: '开始生成' }).click();
  await expect(page.getByRole('button', { name: '停止' })).toBeVisible();
  await page.getByRole('button', { name: '停止' }).click();
  releaseSecond?.();
  await expect(page.getByRole('region', { name: '任务详情' })).toContainText('已取消', { timeout: 10000 });
  expect(await page.getByRole('button', { name: '下载 Markdown' }).count()).toBe(0);
  expect(requests.filter(url => url.includes('/private-models/account/complete'))).toHaveLength(2);
  expect(sent).toHaveLength(2);
  expect(errors).toEqual([]);
  await writeFile(path.join(output, liveProvider ? 'live-result.json' : 'result.json'), JSON.stringify({ passed: true, generation: liveProvider ? 'live provider through backend complete_private' : 'mocked', accountAuth: 'synthetic',
    checks: ['explicit cloud consent', 'encrypted task/input/artifact', 'markdown download', 'reload/unlock', 'cancel without artifact', '390px layout'], providerRequests: liveProvider ? 1 : 0 }, null, 2));
} finally { releaseSecond?.(); await context.close(); }
