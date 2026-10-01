import { readVaultCiphertext } from './vault-qa.mjs';
// Explicitly authorized synthetic test only. Provider credentials stay in a Python subprocess.
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const output = path.resolve('../../.tools/local-answer-qa');
const mockOnly = process.env.LOCAL_ANSWER_MOCK === '1';
await mkdir(output, { recursive: true });
const context = await chromium.launchPersistentContext(path.resolve('../../.tools/local-knowledge-qa/browser-profile'), { headless: true, viewport: { width: 1200, height: 1000 } });
const page = await context.newPage();
for (const old of context.pages()) if (old !== page) await old.close();
const errors = [], sent = [];
page.on('pageerror', error => errors.push(error.message));
async function live(messages) {
  return new Promise((resolve, reject) => {
    const processEnv = { ...process.env, DEBUG: 'true', PYTHONIOENCODING: 'utf-8', PYTHONPATH: path.resolve('../../.tools/python-ops') };
    const child = spawn('python', [path.resolve('../backend/scripts/verify_local_answer_live.py')], { windowsHide: true, env: processEnv, stdio: ['pipe', 'pipe', 'ignore'] });
    let outputText = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Live test timed out')); }, 130000);
    child.stdout.on('data', data => { outputText += data.toString(); if (outputText.length > 200000) child.kill(); });
    child.on('error', () => { clearTimeout(timer); reject(new Error('Live test helper could not start')); });
    child.on('exit', code => {
      clearTimeout(timer);
      try { const result = JSON.parse(outputText); if (code !== 0 || !result.content) {
        console.log('Live helper status:', result.category, result.status); throw new Error();
      } resolve(result); }
      catch { reject(new Error('Live provider check failed; sensitive response suppressed')); }
    });
    child.stdin.end(JSON.stringify({ fixture: 'geiit-local-answer-qa', messages }));
  });
}
// Only authentication/account availability is a fixture. Completions run real backend relay code.
await context.routeWebSocket('**/ws/notifications', () => {});
await context.route('**/api/v1/**', async route => {
  const endpoint = new URL(route.request().url()).pathname;
  if (endpoint.endsWith('/private-models/account')) return route.fulfill({ json: { available: true, model: 'configured-test-model' } });
  if (endpoint.endsWith('/private-models/account/complete/stream')) {
    const body = route.request().postDataJSON(); sent.push(body);
    // The legacy helper is buffered; this does not prove upstream SSE completion.
    const buffered = result => route.fulfill({ contentType: 'text/event-stream', body: 'data: ' + JSON.stringify({ type: 'chunk', content: result.content }) + '\n\n' +
      'data: ' + JSON.stringify({ type: 'done', ...result, finish_reason: 'unknown' }) + '\n\n' });
    if (mockOnly) return buffered({ content: '报销需提交发票、付款凭证和主管审批记录，在出差结束后十个工作日内提交。[1]', model: 'fixture-only-model' });
    try { return await buffered(await live(body.messages)); }
    catch { return route.fulfill({ status: 502, json: { detail: 'Live provider check failed; sensitive response suppressed' } }); }
  }
  return route.fulfill({ status: 200, json: {} });
});
try {
  await page.goto('http://127.0.0.1:1423/workbench');
  await page.evaluate(async () => {
    localStorage.clear();
    localStorage.setItem('kb_auth_tokens', JSON.stringify({ access_token: 'synthetic-test-session', refresh_token: 'synthetic-test-session' }));
    localStorage.setItem('kb_auth_user', JSON.stringify({ id: 101, username: 'synthetic-test-user', email: 'test@example.test', is_active: true, is_superuser: false, user_type: 'regular' }));
    await new Promise((resolve, reject) => { const r = indexedDB.deleteDatabase('geiit-local-knowledge-v1'); r.onsuccess = resolve; r.onerror = reject; });
  });
  await page.reload();
  console.log('Fixture session initialized.');
  await page.getByLabel('解锁口令', { exact: true }).fill('test-only-1234');
  await page.getByLabel('确认口令', { exact: true }).fill('test-only-1234');
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await page.getByRole('link', { name: '本地知识库', exact: true }).click();
  await page.getByRole('button', { name: '自定义兼容 ONNX 模型' }).click();
  await expect(page.getByLabel(/^Hugging Face 仓库/)).toHaveValue('Xenova/multilingual-e5-small');
  await page.getByLabel(/^固定版本 commit/).fill('main');
  await expect(page.getByRole('alert')).toContainText('配置尚未有效');
  await page.getByRole('button', { name: '恢复默认配置' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, 'profile-form-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1200, height: 1000 });
  await page.getByRole('button', { name: '收起', exact: true }).click();
  console.log('Enabling real E5 retrieval.');
  await page.getByRole('button', { name: '启用模型 / 按配置重建' }).click();
  const progress = setInterval(async () => console.log('Local model:', await page.getByRole('status').first().textContent().catch(() => 'waiting')), 15000);
  try { await Promise.race([
    expect(page.getByRole('button', { name: '选择文件并建立索引' })).toBeEnabled({ timeout: 600000 }),
    page.getByRole('alert').first().waitFor({ state: 'visible', timeout: 600000 }).then(() => { throw new Error('Local model initialization failed'); }),
  ]); } finally { clearInterval(progress); }
  console.log('Local model ready.');
  await page.getByLabel('选择本地文档').setInputFiles({ name: '测试报销制度.md', mimeType: 'text/markdown', buffer: Buffer.from('这是一份自动化测试专用虚构制度。员工报销必须提交发票、付款凭证和主管审批记录；出差结束后十个工作日内提交财务。') });
  await expect(page.getByRole('status').first()).toContainText('导入完成', { timeout: 60000 });
  await page.getByLabel('本地检索问题').fill('报销需要哪些材料，何时提交？');
  await page.getByRole('button', { name: '本地检索', exact: true }).click();
  const answer = page.getByRole('region', { name: '根据本地来源生成回答' });
  await expect(answer).toBeVisible({ timeout: 60000 });
  await answer.getByRole('button', { name: '检查账号云端模型权限' }).click();
  await answer.getByLabel('回答生成模型', { exact: true }).selectOption('$account');
  const generate = answer.getByRole('button', { name: '根据所选来源生成回答' });
  await expect(generate).toBeDisabled(); expect(sent).toHaveLength(0);
  await answer.getByLabel('我允许本次将所选本地片段', { exact: false }).check();
  await generate.click();
  console.log(`Explicit consent submitted; testing ${mockOnly ? 'mock generation' : 'configured provider'}.`);
  await Promise.race([
    expect(answer.locator('.lk-answer')).toBeVisible({ timeout: 130000 }),
    answer.getByRole('alert').waitFor({ state: 'visible', timeout: 130000 }).then(() => { throw new Error('Live answer failed; provider details suppressed'); }),
  ]);
  const content = await answer.locator('.lk-answer > pre').innerText();
  expect(content).toContain('[1]'); expect(content).toContain('发票'); expect(content).toContain('付款凭证');
  expect(sent).toHaveLength(1); expect(sent[0]).not.toHaveProperty('max_tokens');
  expect(JSON.parse(sent[0].messages[1].content).sources).toHaveLength(1);
  await expect(generate).toBeDisabled(); // no consent reuse
  await page.getByLabel('本地检索问题').fill('尚未重新检索的问题');
  await expect(answer.getByText('问题：报销需要哪些材料，何时提交？')).toBeVisible();
  const downloadEvent = page.waitForEvent('download');
  await answer.getByRole('button', { name: '导出回答 Markdown' }).click();
  const download = await downloadEvent;
  const markdown = await readFile(await download.path(), 'utf8');
  expect(markdown).toContain('来源快照'); expect(markdown).toContain(content);
  expect(markdown).toContain('测试报销制度.md'); expect(markdown).not.toContain('尚未重新检索的问题');
  expect(markdown).not.toMatch(/vector|apiKey|synthetic-test-session/);
  await answer.getByRole('button', { name: '保存为独立对话记录' }).click();
  await expect(answer.getByRole('button', { name: '已保存到工作台' })).toBeDisabled();
  expect(await readVaultCiphertext(page)).not.toContain('主管审批记录');
  await page.screenshot({ path: path.join(output, mockOnly ? 'mock-answer-saved.png' : 'live-answer.png'), fullPage: true });
  await answer.getByRole('link', { name: '打开已保存记录' }).click();
  await expect(page.getByText(/此记录不能继续发送给模型/)).toBeVisible();
  await expect(page.getByLabel('当前对话模型')).toBeDisabled();
  await expect(page.getByLabel('消息', { exact: true })).toHaveCount(0);
  await page.reload();
  await page.getByLabel('解锁口令', { exact: true }).fill('test-only-1234');
  await page.getByRole('button', { name: '解锁', exact: true }).click();
  await expect(page.getByText(/此记录不能继续发送给模型/)).toBeVisible();
  await expect(page.locator('main article')).toContainText('主管审批记录');
  expect(sent).toHaveLength(1);
  await page.screenshot({ path: path.join(output, 'saved-answer-reopened.png'), fullPage: true });
  expect(errors).toEqual([]);
  await writeFile(path.join(output, mockOnly ? 'mock-result.json' : 'result.json'), JSON.stringify({ passed: true, providerRequests: mockOnly ? 0 : sent.length, citedSource: content.includes('[1]'),
    artifactChecks: ['model form', 'Markdown download', 'encrypted archive', 'reload/unlock', 'read-only no extra request'],
    scope: mockOnly ? 'Real E5/WASM retrieval; mocked buffered generation and account auth; form, consent and artifact UI.' : 'Real E5/WASM retrieval + buffered backend complete_private/provider; synthetic account auth/availability; NOT upstream stream/finish verification; fixture document only; no credentials written.' }, null, 2));
  console.log(`Real E5 retrieval, explicit cloud consent, ${mockOnly ? 'MOCKED' : 'LIVE'} answer, export, encrypted read-only archive and reload passed.`);
} finally { await context.close(); }
