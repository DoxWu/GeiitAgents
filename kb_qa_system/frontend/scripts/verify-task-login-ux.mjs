// Isolated browser fixtures. Start Vite on 1427; no real accounts or paid calls.
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.env.UX_QA_URL || 'http://127.0.0.1:1427';
const output = path.resolve('../../.tools/task-login-ux-qa');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  // Block every external request except the synthetic account/model routes below.
  await context.route('**/*', route => new URL(route.request().url()).origin === root ? route.continue() : route.abort());
  let status = 401, releaseLogin;
  await context.route('https://organization.example/api/v1/auth/login', async route => {
    expect(route.request().headers().authorization).toBeUndefined();
    if (status === 'pending') await new Promise(resolve => { releaseLogin = resolve; });
    if (status === 'network') return route.abort('failed');
    return route.fulfill({ status: typeof status === 'number' ? status : 401, headers: { 'X-Request-ID': 'ux-fixture-request', 'Access-Control-Expose-Headers': 'X-Request-ID' }, json: { detail: 'fixture rejection' } });
  });
  await page.goto(`${root}/login`);
  await expect(page.getByRole('heading', { name: 'GeiIt 工作台' })).toBeVisible();
  const close = page.getByRole('link', { name: '关闭登录并返回工作台' });
  await expect(close.locator('svg')).toBeVisible();
  expect(await close.innerText()).toBe('');
  await expect(page.getByRole('status')).toContainText('尚未发起登录请求');
  await page.getByLabel('账号服务器地址').fill('https://organization.example');
  await page.getByRole('button', { name: '使用此地址' }).click();
  await page.getByLabel('邮箱', { exact: true }).fill('fixture@example.com');
  await page.getByLabel('密码', { exact: true }).fill('fixture-password');
  for (const code of [401, 404, 502, 'network']) {
    status = code;
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const diagnostic = page.getByRole('status', { name: '登录请求诊断' });
    if (code === 'network') {
      await expect(diagnostic).toContainText('HTTP 状态码不可用');
      await expect(diagnostic).toContainText('无法确认服务器是否收到');
      expect(await diagnostic.innerText()).not.toMatch(/HTTP 0|fixture-password|fixture@example/);
    } else {
      await expect(diagnostic).toContainText(`HTTP ${code}`);
      await expect(diagnostic).toContainText('ux-fixture-request');
    }
    await expect(diagnostic).toContainText('POST https://organization.example/api/v1/auth/login');
  }
  await page.screenshot({ path: path.join(output, 'login-diagnostic.png'), fullPage: true, animations: 'disabled' });
  status = 'pending';
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('status', { name: '登录请求诊断' })).toContainText('正在发起');
  await close.click();
  await expect(page).toHaveURL(/\/workbench$/);
  await expect.poll(() => typeof releaseLogin).toBe('function');
  releaseLogin();
  await expect(page).toHaveURL(/\/workbench$/);

  await page.getByLabel('解锁口令', { exact: true }).fill('fixture-password');
  await page.getByLabel('确认口令', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await page.getByRole('tab', { name: '模型', exact: true }).click();
  await page.getByLabel('连接名称').fill('UX fixture');
  await page.getByLabel('API Base URL').fill('https://provider.example/v1');
  await page.getByLabel('API Key', { exact: true }).fill('fixture-only-key');
  await page.getByLabel('模型名称', { exact: true }).fill('fixture-chat');
  await page.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('连接已加密保存');

  let releaseModel;
  await context.route('https://provider.example/v1/chat/completions', async route => {
    const body = route.request().postDataJSON();
    if (body.tools && body.messages.some(message => message.role === 'tool')) {
      return route.fulfill({ json: { choices: [{ message: { content: '任务总结内容。\n'.repeat(150) }, finish_reason: 'stop' }] } });
    }
    await new Promise(resolve => { releaseModel = resolve; });
    releaseModel = undefined;
    if (body.tools) return route.fulfill({ json: { choices: [{ message: { content: null, tool_calls: [{ id: 'fixture-document', type: 'function', function: { name: 'create_document', arguments: JSON.stringify({ title: 'UX 成果', markdown: '# UX 成果\n\n可以直接查看的合成文档。' }) } }] }, finish_reason: 'tool_calls' }] } });
    const wire = 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '# UX 成果\n\n可以直接查看的合成文档。' } }] }) + '\n\n'
      + 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n';
    return route.fulfill({ contentType: 'text/event-stream', body: wire });
  });
  async function viewportCheck(locator) {
    // Visibility includes clipping by the panel; Playwright's toBeVisible alone does not.
    const geometry = () => locator.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const nav = document.querySelector('[aria-label="任务区域导航"]')?.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + Math.min(rect.width / 2, 100), rect.top + 8);
      return { top: rect.top, bottom: rect.bottom, navBottom: nav?.bottom, height: innerHeight, hit: hit?.tagName, text: hit?.textContent?.slice(0, 100), visible: rect.top >= (nav?.bottom || 0) - 1 && rect.top < innerHeight - 24 && Boolean(element.contains(hit) || hit?.contains(element)) };
    });
    try { await expect.poll(async () => (await geometry()).visible).toBe(true); }
    catch (error) {
      console.log(await geometry());
      await page.screenshot({ path: path.join(output, 'viewport-failure.png'), animations: 'disabled' });
      throw error;
    }
  }
  async function finishModel() {
    await expect.poll(() => typeof releaseModel).toBe('function');
    releaseModel();
  }
  await page.getByRole('tab', { name: '任务', exact: true }).click();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.getByRole('tab', { name: '文档生成', exact: true }).click();
    await page.getByRole('button', { name: '任务设置 / 新建任务', exact: true }).click();
    const title = `UX 文档 ${width}`;
    await page.getByLabel('文档标题', { exact: true }).fill(title);
    await page.getByLabel('生成要求', { exact: true }).fill('生成可读成果');
    await page.getByLabel('参考材料（可选）', { exact: true }).fill('合成参考材料。\n'.repeat(80));
    await page.getByLabel(/我允许本次/).check();
    await page.getByRole('button', { name: '开始生成', exact: true }).click();
    const documentResult = page.getByRole('region', { name: '任务详情' });
    await expect(documentResult).toContainText('运行中');
    await viewportCheck(documentResult.getByRole('heading', { name: title, exact: true }));
    await page.screenshot({ path: path.join(output, `document-running-${width}.png`), animations: 'disabled' });
    await finishModel();
    await expect(documentResult).toContainText('已完成');
    await viewportCheck(page.getByRole('article', { name: '文档成果' }).getByRole('heading', { name: 'UX 成果', exact: true }));
    await documentResult.getByRole('button', { name: '复用输入', exact: true }).click();
    await expect(page.getByLabel('文档标题', { exact: true })).toHaveValue(title);
    await viewportCheck(page.getByLabel('文档标题', { exact: true }));
    await page.getByRole('button', { name: '过程与成果', exact: true }).click();
    await viewportCheck(documentResult.getByRole('heading', { name: title, exact: true }));

    await page.getByRole('tab', { name: '图表工具', exact: true }).click();
    await page.getByRole('button', { name: '任务设置 / 新建任务', exact: true }).click();
    await page.getByLabel('图表标题').fill(`UX 图表 ${width}`);
    await page.getByRole('button', { name: '检查并预览', exact: true }).click();
    await page.getByRole('button', { name: '保存图表任务', exact: true }).click();
    const chartResult = page.getByRole('region', { name: '图表任务详情' });
    await expect(chartResult).toContainText('已完成');
    await viewportCheck(chartResult.getByRole('heading', { name: `UX 图表 ${width}`, exact: true }));
    await page.screenshot({ path: path.join(output, `chart-completed-${width}.png`), animations: 'disabled' });

    await page.getByRole('tab', { name: '多步骤任务', exact: true }).click();
    await page.getByRole('button', { name: '任务设置 / 新建任务', exact: true }).click();
    await page.getByLabel('任务标题').fill(`UX 多步骤 ${width}`);
    await page.getByLabel('办公目标').fill('整理为文档成果');
    await page.getByLabel(/允许本次最多 6 轮/).check();
    await page.getByRole('button', { name: '开始多步骤任务', exact: true }).click();
    const toolsResult = page.getByRole('region', { name: '多步骤任务详情' });
    await expect(toolsResult).toContainText('运行中');
    await viewportCheck(toolsResult.getByRole('heading', { level: 2 }));
    await finishModel();
    await expect(toolsResult).toContainText('已完成');
    await viewportCheck(toolsResult.getByRole('heading', { name: 'UX 成果', exact: true }));
    const artifactTop = (await toolsResult.getByRole('region', { name: '多步骤任务成果' }).boundingBox()).y;
    expect(artifactTop).toBeLessThan((await toolsResult.getByRole('heading', { name: '执行过程' }).boundingBox()).y);
    await page.screenshot({ path: path.join(output, `tools-completed-${width}.png`), animations: 'disabled' });

    await page.getByRole('tab', { name: '可视化工作流', exact: true }).click();
    await page.getByRole('button', { name: '新建工作流', exact: true }).click();
    await page.getByLabel('工作流名称').fill(`UX 工作流 ${width}`);
    await page.getByRole('button', { name: '添加模型生成文档', exact: true }).click();
    await page.getByRole('button', { name: '保存工作流', exact: true }).click();
    await expect(page.getByRole('button', { name: '手动运行工作流', exact: true })).toBeDisabled();
    await page.getByLabel(/允许本次按已保存工作流/).check();
    await page.getByRole('button', { name: '手动运行工作流', exact: true }).click();
    const workflowResult = page.getByRole('region', { name: '工作流运行历史' });
    await expect(workflowResult).toContainText('运行中');
    await viewportCheck(workflowResult.getByRole('heading', { name: '运行历史' }));
    await finishModel();
    await expect(workflowResult).toContainText('已完成');
    await viewportCheck(workflowResult.getByRole('heading', { name: 'UX 成果', exact: true }));
    expect((await workflowResult.getByRole('region', { name: '多步骤任务成果' }).boundingBox()).y).toBeLessThan((await page.getByRole('list', { name: '工作流执行过程' }).boundingBox()).y);
    await page.screenshot({ path: path.join(output, `workflow-completed-${width}.png`), animations: 'disabled' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  expect(errors).toEqual([]);
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, widths: [1280, 390], checks: ['login X and title', 'unsubmitted/pending/HTTP 401/404/502/network diagnostics', 'close while pending', 'real document/chart/tools/workflow starts', 'viewport and sticky navigation', 'completed artifact priority', 'draft reuse and result jump'], fixtureOnly: true }, null, 2));
  console.log('PASS: login diagnostics and four task types at desktop/mobile widths. Fixture requests only.');
} finally { await browser.close(); }
