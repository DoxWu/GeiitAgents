// Production workflow UI, real encrypted storage and synthetic HTTP generation.
// No real providers, model weights or external files.
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { createServer as socket } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';

const mode = ['native', 'relay', 'account'].find(value => process.argv.includes('--' + value)) || 'web';
const output = path.resolve('../../.tools/workflow-qa', mode); await mkdir(output, { recursive: true });
const streams = new Map(), calls = [], errors = [], requests = [];
const event = data => 'data: ' + JSON.stringify(data) + '\n\n';
const contentEvent = content => event({ choices: [{ index: 0, delta: { content } }] });
const service = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*'); response.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()), input = JSON.parse(body.messages.at(-1).content), name = input.title || input.question;
    if (request.headers.authorization !== 'Bearer native-stream-fixture-key' || body.stream !== true || request.url !== '/v1/chat/completions' || 'max_tokens' in body) throw new Error('Unexpected synthetic request');
    calls.push({ name, body }); response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' }); response.flushHeaders();
    const stream = { response, closed: false }; streams.set(name, stream); response.on('close', () => { stream.closed = true; });
    const first = Buffer.from(contentEvent('# 增量中文🌏 ' + name)); const split = first.indexOf(Buffer.from('🌏')) + 1;
    response.write(first.subarray(0, split)); setTimeout(() => { if (!response.destroyed) response.write(first.subarray(split)); }, 20);
  } catch (error) { errors.push(String(error)); response.writeHead(500); response.end(); }
});
await new Promise(resolve => service.listen(0, '127.0.0.1', resolve)); const upstream = 'http://127.0.0.1:' + service.address().port;
async function unusedPort() { const probe = socket(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); return port; }
let app, backend, browser, context, page;
try {
  const port = await unusedPort();
  if (mode === 'native') {
    const profile = await mkdtemp(path.join(output, 'webview-'));
    app = spawn(path.resolve('src-tauri/target-dev/release/geiit-workbench.exe'), [], { windowsHide: true, stdio: 'ignore', env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port } });
    let launchError; app.on('error', error => { launchError = error; });
    for (let attempt = 0; attempt < 60; attempt++) {
      if (launchError) throw launchError; if (app.exitCode !== null) throw new Error('Native app exited');
      try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 700 }); break; } catch { await new Promise(resolve => setTimeout(resolve, 200)); }
    }
    if (!browser) throw new Error('Native debugger unavailable'); context = browser.contexts()[0]; page = context.pages()[0] || await context.waitForEvent('page');
  } else {
    const url = 'http://127.0.0.1:' + port + '/workbench';
    app = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--configLoader', 'runner', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { windowsHide: true, stdio: 'ignore' });
    await expect.poll(async () => { try { return (await fetch(url)).ok; } catch { return false; } }, { timeout: 15000 }).toBe(true);
    browser = await chromium.launch({ headless: true }); context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
    if (['relay', 'account'].includes(mode)) {
      const apiPort = await unusedPort(), api = 'http://127.0.0.1:' + apiPort;
      backend = spawn('python', ['tests/model_stream_qa_server.py'], { cwd: path.resolve('../backend'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
        ...process.env, DEBUG: 'true', PYTHONPATH: [path.resolve('../backend'), path.resolve('../../.tools/python-tools-provider'), path.resolve('../../.tools/python-ops')].join(path.delimiter), MODEL_STREAM_QA_PORT: String(apiPort), MODEL_STREAM_QA_UPSTREAM: upstream,
      } });
      let logs = ''; backend.stdout.on('data', data => { logs += data; }); backend.stderr.on('data', data => { logs += data; });
      await expect.poll(async () => { if (backend.exitCode !== null) throw new Error(logs); try { return (await fetch(api + '/healthz')).ok; } catch { return false; } }, { timeout: 15000 }).toBe(true);
      await context.route('**/api/v1/**', route => route.continue({ url: api + new URL(route.request().url()).pathname }));
      await context.addInitScript(() => {
        localStorage.setItem('kb_auth_tokens', JSON.stringify({ access_token: 'stream-account-fixture', refresh_token: 'fixture' }));
        localStorage.setItem('kb_auth_user', JSON.stringify({ id: 1, username: 'stream-qa', email: 'stream@example.test', is_active: true, is_superuser: false, user_type: 'regular' }));
      });
    } else await context.route('**/api/v1/**', route => route.fulfill({ json: {} }));
    page = await context.newPage(); await page.goto(url);
  }
  page.on('pageerror', error => errors.push(error.message)); context.on('request', request => requests.push(request.url()));
  await context.routeWebSocket('**/ws/notifications', () => {});
  const button = name => page.getByRole('button', { name, exact: true }), field = name => page.getByLabel(name, { exact: true });
  async function unlock(create = false) { await field('解锁口令').fill('qa-generation-1234'); if (create) await field('确认口令').fill('qa-generation-1234'); await button(create ? '创建' : '解锁').click(); await expect(page.getByText('本机密钥库已解锁', { exact: true })).toBeVisible(); }
  async function finish(name, reason) { const stream = streams.get(name); stream.response.write(contentEvent('\n正文结尾 [1]')); stream.response.write(event({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })); await expect.poll(() => stream.closed).toBe(true); }
  async function download(name, filename) { const pending = page.waitForEvent('download'); await button(name).click(); const file = await pending; const target = path.join(output, filename); await file.saveAs(target); return readFile(target); }
  await unlock(true);
  if (mode !== 'account') {
    await button('模型连接').click(); await field('调用方式').selectOption(mode === 'relay' ? 'relay' : 'local'); await field('连接名称').fill('合成生成连接');
    await field('API Base URL').fill(mode === 'relay' ? 'https://models.example/v1' : upstream + '/v1'); await field('模型名称').fill('native-chat'); await field('API Key').fill('native-stream-fixture-key');
    await button('保存连接').click(); await expect(page.getByRole('status')).toHaveText('连接已加密保存到本机。');
  }
  const workflow = async () => { await page.getByRole('tab', { name: '任务', exact: true }).click(); await page.getByRole('tab', { name: '可视化工作流', exact: true }).click(); };
  await workflow();
  await field('工作流名称').fill('合成工作流');
  await button('添加检查 CSV').click(); await button('添加生成图表').click(); await button('添加整理 Markdown').click();
  await field('Markdown 正文').fill('# 合成报告\n\n本地生成。');
  const options = await field('前置步骤').locator('option').evaluateAll(nodes => nodes.map(n => n.value));
  async function connect(from, to) { await field('前置步骤').selectOption(from); await field('后续步骤').selectOption(to); await button('连接步骤').click(); }
  await connect(options[1], options[2]); await connect(options[1], options[3]); await connect(options[2], options[3]);
  await connect(options[3], options[1]); await expect(page.getByRole('alert')).toContainText('循环依赖');
  const handle = button('移动步骤 1'); await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox(); await page.mouse.move(box.x + 30, box.y + 6); await page.mouse.down(); await page.mouse.move(box.x + 70, box.y + 146, { steps: 5 }); await page.mouse.up();
  await handle.press('ArrowRight'); await button('保存工作流').click(); await expect(page.getByRole('status')).toContainText('修订 1');
  const workflowId = await field('已保存工作流').inputValue();
  const xlsx = new JSZip();
  xlsx.file('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="销量" sheetId="1" r:id="rId1"/></sheets></workbook>');
  xlsx.file('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  xlsx.file('xl/worksheets/sheet1.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>月份</t></is></c><c r="B1" t="inlineStr"><is><t>销量</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>一月</t></is></c><c r="B2"><v>12</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>二月</t></is></c><c r="B3"><v>18</v></c></row></sheetData></worksheet>');
  await field('选择工作流 CSV 或 XLSX 文件').setInputFiles({ name: 'workflow.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: await xlsx.generateAsync({ type: 'nodebuffer' }) });
  await expect(page.getByText('工作表：销量', { exact: true })).toBeVisible();
  await expect(field('工作流 CSV')).toHaveValue('月份,销量\n一月,12\n二月,18');
  await field('工作流参考材料').fill('合成资料：一月与二月。');
  await button('手动运行工作流').click(); const history = page.getByLabel('工作流运行历史', { exact: true });
  await expect(history).toContainText('已按依赖顺序完成 3 个步骤'); expect(calls).toHaveLength(0);
  const csvRun = await field('选择工作流运行').inputValue();
  await field('选择工作流成果').selectOption({ label: '整理 Markdown.md' });
  expect((await download('下载成果', 'workflow.md')).toString()).toMatch(/合成报告[\s\S]*一月[\s\S]*sha256/);
  const docx = await JSZip.loadAsync(await download('导出 Word', 'workflow.docx'));
  expect(await docx.file('word/document.xml').async('string')).toContain('合成报告');
  await page.getByLabel('工作流画布').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, 'canvas.png') });
  if (mode === 'web') {
    await page.setViewportSize({ width: 390, height: 844 }); await page.getByLabel('工作流画布').scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: path.join(output, 'mobile.png') }); await page.setViewportSize({ width: 1280, height: 900 });
  }
  await page.reload(); await unlock(); await workflow(); await field('已保存工作流').selectOption(workflowId);
  expect(await button('移动步骤 1').evaluate(n => n.parentElement.style.left)).toBe('84px');
  await field('选择工作流运行').selectOption(csvRun); await expect(history).toContainText('已按依赖顺序完成 3 个步骤');
  // Add a strict model node after the saved local document. Its consent applies
  // only to this saved revision and these runtime inputs.
  await button('添加模型生成文档').click(); await field('步骤标题').fill('Workflow success');
  await field('步骤生成要求').fill('根据合成资料生成报告');
  const modelNode = await field('后续步骤').locator('option').last().getAttribute('value'); await connect(options[3], modelNode);
  await button('保存工作流').click(); await expect(page.getByRole('status')).toContainText('修订 2');
  await field('工作流 CSV').fill('月份,销量\n一月,12\n二月,18'); await field('工作流参考材料').fill('仅本次授权的资料');
  if (mode === 'account') await field('工作流模型').selectOption('$account');
  async function startModel(name, revision) {
    if (revision) { await button('编辑步骤 4').click(); await field('步骤标题').fill(name); await button('保存工作流').click(); await expect(page.getByRole('status')).toContainText('修订 ' + revision); }
    if (['relay', 'account'].includes(mode)) { await expect(button('手动运行工作流')).toBeDisabled(); await page.getByLabel(/允许本次按已保存工作流/).check(); }
    await button('手动运行工作流').click(); await expect(page.getByLabel('工作流模型生成预览')).toContainText(name);
    if (['relay', 'account'].includes(mode)) await expect(page.getByLabel(/允许本次按已保存工作流/)).not.toBeChecked();
  }
  await startModel('Workflow success'); await finish('Workflow success', 'stop'); await expect(history).toContainText('已按依赖顺序完成 4 个步骤');
  const successful = calls[0]; expect(successful.body.messages[1].content).toContain('仅本次授权的资料');
  expect(successful.body.messages[1].content).toContain('合成报告');
  await startModel('Workflow partial', 3); await finish('Workflow partial', 'length'); await expect(history).toContainText('模型未报告正常完成');
  await field('选择工作流成果').selectOption({ label: 'Workflow partial.md' });
  expect((await download('下载成果', 'partial.md')).toString()).toContain('生成状态');
  await startModel('Workflow EOF', 4); streams.get('Workflow EOF').response.end(); await expect(history).toContainText('中断');
  await startModel('Workflow stop', 5); await button('停止工作流').click(); await expect.poll(() => streams.get('Workflow stop').closed).toBe(true); await expect(history).toContainText('已取消');
  await startModel('Workflow lock', 6); await button('锁定本机密钥库').click(); await expect.poll(() => streams.get('Workflow lock').closed).toBe(true);
  await unlock(); await workflow(); await expect(history).toContainText('已中断'); await expect(history).toContainText('2 个成果');
  await field('已保存工作流').selectOption(workflowId);
  // Actual encrypted portable backup includes the definition, snapshots and all
  // completed checkpoints; restoring it does not rerun any node.
  await button('工作台备份').click(); await field('备份口令').fill('workflow-backup'); await field('确认备份口令').fill('workflow-backup');
  const pending = page.waitForEvent('download'); await button('下载加密工作台备份').click(); const downloaded = await pending;
  const backup = path.join(output, 'workflows.geiitwork'); await downloaded.saveAs(backup);
  expect((await readFile(backup, 'utf8'))).not.toContain('合成工作流');
  await button('锁定本机密钥库').click(); await field('工作台备份文件').setInputFiles(backup);
  await field('此备份的口令').fill('workflow-backup'); await field('恢复后的新解锁口令').fill('qa-generation-1234'); await field('确认新解锁口令').fill('qa-generation-1234');
  await button('解密并预检查备份').click(); await expect(page.getByText(/工作流定义 1 个/)).toBeVisible();
  await page.getByLabel(/我已核对备份内容/).check(); await button('确认恢复工作台').click(); await expect(page.getByText(/恢复已完成/)).toBeVisible();
  await page.getByRole('tab', { name: '对话', exact: true }).click(); await unlock(); await workflow(); await field('已保存工作流').selectOption(workflowId);
  await expect(field('工作流名称')).toHaveValue('合成工作流'); await expect(history).toContainText('已中断');
  expect(calls).toHaveLength(5); expect(errors).toEqual([]);
  expect(requests.filter(url => /huggingface|\.onnx(?:\?|$)/.test(url))).toEqual([]);
  if (mode === 'native') expect(requests.filter(url => url.startsWith(upstream))).toEqual([]);
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, mode, requests: calls.length, checks: ['canvas pointer/keyboard movement', 'fork/join and cycle rejection', 'XLSX sheet import into encrypted workflow input', 'local tools and actual Markdown/DOCX downloads', 'strict incremental model, partial, EOF, stop, lock', 'per-run cloud consent', 'encrypted definitions/revisions/run snapshots', 'backup restore without replay', 'no embedding downloads'], docx: 'download XML only; no pagination', errors }, null, 2));
  console.log(`Workflow ${mode} QA passed: ${output}`);
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); await writeFile(path.join(output, 'failure.json'), JSON.stringify({ message: String(error), errors }, null, 2)); throw error;
} finally {
  for (const stream of streams.values()) stream.response.destroy(); await browser?.close(); app?.kill(); backend?.kill(); service.closeAllConnections(); await new Promise(resolve => service.close(resolve));
}
