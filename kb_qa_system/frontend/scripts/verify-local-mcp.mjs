// Explicit desktop acceptance: installs two public packages, reads only a
// synthetic fixture, then removes only the installations created by this run.
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('../../.tools/local-mcp-20261102');
await mkdir(root, { recursive: true });
const output = await mkdtemp(path.join(root, 'run-'));
const fixture = path.join(output, 'fixture'); await mkdir(fixture);
await writeFile(path.join(fixture, 'sample.txt'), 'Local MCP synthetic acceptance.');
const exe = path.resolve('src-tauri/target-dev/release/geiit-workbench.exe');
let modelRequests = 0;
const modelServer = createHttpServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString()); modelRequests++;
  const system = body.messages.find(message => message.role === 'system')?.content ?? '';
  const resourceId = system.match(/id=([\da-f-]{36})/)?.[1];
  const completed = body.messages.some(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('"toolResult"'));
  const toolArguments = { path: path.join(fixture, 'sample.txt') };
  const inputs = system.includes('"key":"arguments"') ? { arguments: JSON.stringify(toolArguments) } : toolArguments;
  const content = completed ? JSON.stringify({ result: 'MCP_TASK_OK' }) : JSON.stringify({ $tool: { id: resourceId, inputs } });
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
});
await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const app = spawn(exe, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env,
  WEBVIEW2_USER_DATA_FOLDER: path.join(output, 'webview'),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`,
} });
let browser, page, before = []; const installed = [], checks = [], errors = [];
const mark = value => { checks.push(value); console.log(value); };
const bounded = async (operation, milliseconds = 10000) => {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Acceptance operation timeout')), milliseconds); })]); }
  finally { clearTimeout(timer); }
};
const native = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const rejection = operation => operation.then(() => 'UNEXPECTED_SUCCESS', error => String(error));
await writeFile(path.join(output, 'launch.json'), JSON.stringify({ pid: app.pid, port, exe }, null, 2));
console.log(JSON.stringify({ output, pid: app.pid, port }));
try {
  await expect.poll(async () => { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 600 }); return true; } catch { return false; } }, { timeout: 30000 }).toBe(true);
  const context = browser.contexts()[0];
  await context.route('**/api/v1/**', route => route.fulfill({ json: route.request().url().includes('server-images') ? { models: [] } : { available: false } }));
  await context.routeWebSocket('**/ws/notifications', () => {});
  page = context.pages()[0]; page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  // Keep the acceptance window away from normal desktop interaction. Only the
  // process launched above is moved; other application windows are untouched.
  await new Promise(resolve => {
    const move = spawn('powershell.exe', ['-NoProfile', '-Command', `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class McpAcceptanceWindow { [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int z, uint flags); }'; $target = Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue; if ($target -and $target.MainWindowHandle -ne 0) { [void][McpAcceptanceWindow]::SetWindowPos($target.MainWindowHandle, [IntPtr]::Zero, -24000, 0, 0, 0, 21) }`], { windowsHide: true, stdio: 'ignore' });
    move.on('error', resolve); move.on('exit', resolve);
  });
  before = await native('mcp_packages');
  await expect(page.getByLabel('确认口令', { exact: true })).toBeVisible();
  await page.getByLabel('解锁口令', { exact: true }).fill('local-mcp-fixture-1234');
  await page.getByLabel('确认口令', { exact: true }).fill('local-mcp-fixture-1234');
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await page.getByRole('tab', { name: '任务', exact: true }).click();
  await page.getByRole('tab', { name: '资源仓库', exact: true }).click();
  await page.getByRole('button', { name: '新建MCP', exact: true }).click();
  await page.getByLabel('MCP transport', { exact: true }).selectOption('stdio');
  const kind = page.getByLabel('MCP 包类型'), name = page.getByLabel('MCP 包名'), version = page.getByLabel('MCP 包精确版本');
  await kind.selectOption('npm'); await name.fill('@modelcontextprotocol/server-filesystem'); await version.fill('2.1.0');
  await page.getByRole('button', { name: '安装', exact: true }).click();
  await expect(page.getByRole('button', { name: '安装', exact: true })).toBeEnabled({ timeout: 615000 });
  await expect(page.getByRole('status')).toContainText('已安装');
  let packages = await native('mcp_packages');
  const npm = packages.find(item => !before.some(old => old.id === item.id));
  expect(npm?.ecosystem).toBe('npm'); installed.push(npm.id);
  mark('actual UI installs exact npm package using the desktop command');
  await page.getByLabel('MCP 附加参数').fill(fixture);
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '连接并发现工具', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已发现', { timeout: 30000 });
  await page.getByRole('checkbox', { name: /read_text_file/ }).check();
  await page.getByRole('button', { name: '加密保存选中工具', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已加密保存 1 个工具');
  expect(await page.evaluate(() => Object.values(localStorage).some(value => typeof value === 'string' && value.includes('server-filesystem')))).toBe(false);
  mark('UI discovers, selects and encrypts a local stdio tool');
  await page.getByRole('tab', { name: '智能体仓库', exact: true }).click();
  await page.getByLabel('智能体名称', { exact: true }).fill('MCP acceptance agent');
  await page.getByLabel('系统指令', { exact: true }).fill('Use the configured tool to read the synthetic fixture and return the result.');
  await page.getByRole('checkbox', { name: /read_text_file/ }).check();
  await page.getByRole('button', { name: '保存到私有仓库', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('保存');
  await page.getByRole('button', { name: '模型连接', exact: true }).click();
  await page.getByLabel('连接名称', { exact: true }).fill('MCP synthetic model');
  await page.getByLabel('调用方式', { exact: true }).selectOption('local');
  await page.getByLabel('API Base URL', { exact: true }).fill(`http://127.0.0.1:${modelServer.address().port}/v1`);
  await page.getByLabel('模型名称', { exact: true }).fill('mcp-fixture-model');
  await page.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('连接已加密保存');
  await page.getByRole('tab', { name: '任务', exact: true }).click();
  await page.getByRole('tab', { name: '长任务', exact: true }).click();
  await page.getByRole('tab', { name: '自主多步骤与历史', exact: true }).click();
  await page.getByText('使用仓库智能体编排多步骤任务', { exact: true }).click();
  await page.getByRole('button', { name: '添加仓库智能体步骤', exact: true }).click();
  await page.getByRole('combobox', { name: /^从私有仓库选择智能体/ }).selectOption({ label: 'MCP acceptance agent' });
  await page.getByRole('combobox', { name: /^输入来源/ }).selectOption('reference');
  await page.getByLabel('本次参考材料', { exact: true }).fill('Read the synthetic fixture.');
  const consent = page.getByRole('checkbox', { name: /允许本次将所选智能体指令/ });
  if (await consent.count()) await consent.check();
  await page.getByRole('button', { name: '保存并运行智能体任务', exact: true }).click();
  const taskResult = page.getByRole('region', { name: '智能体顺序任务结果' });
  await expect(taskResult).toContainText('succeeded', { timeout: 40000 });
  expect(modelRequests).toBe(2);
  mark('real UI agent workflow authorizes, calls npm stdio and completes with synthetic model replies');
  await page.getByRole('tab', { name: '资源仓库', exact: true }).click();
  const config = { connectionId: crypto.randomUUID(), installationId: npm.id, entryPoint: npm.entryPoints[0], args: [fixture] };
  const sessionId = crypto.randomUUID(), env = {};
  const tools = await native('mcp_discover', { sessionId, requestId: crypto.randomUUID(), config, env });
  expect(tools.some(item => item.name === 'read_text_file')).toBe(true);
  expect(await rejection(native('mcp_call', { sessionId, requestId: crypto.randomUUID(), config, env, tool: 'read_text_file', arguments: { path: path.join(fixture, 'sample.txt') } }))).toContain('MCP_NOT_APPROVED');
  await native('mcp_approve', { sessionId, config, tools: ['read_text_file'] });
  const result = await native('mcp_call', { sessionId, requestId: crypto.randomUUID(), config, env, tool: 'read_text_file', arguments: { path: path.join(fixture, 'sample.txt') } });
  expect(JSON.stringify(result)).toContain('Local MCP synthetic acceptance.');
  expect(await rejection(native('mcp_status', { sessionId, config, tool: 'read_text_file', env: { EXAMPLE: 'changed' } }))).toContain('MCP_NOT_APPROVED');
  await native('mcp_disconnect', { sessionId });
  expect(await rejection(native('mcp_status', { sessionId, config, tool: 'read_text_file', env }))).toContain('MCP_NOT_CONNECTED');
  mark('real npm stdio call requires matching per-session approval and environment');
  await native('mcp_discover', { sessionId, requestId: crypto.randomUUID(), config, env });
  await native('mcp_approve', { sessionId, config, tools: ['read_text_file'] });
  await native('mcp_lock');
  expect(await rejection(native('mcp_status', { sessionId, config, tool: 'read_text_file', env }))).toContain('MCP_NOT_CONNECTED');
  mark('locking revokes connected local MCP tools');
  await page.getByRole('button', { name: '新建MCP', exact: true }).click();
  await page.getByLabel('MCP transport', { exact: true }).selectOption('stdio');
  await kind.selectOption('python'); await page.getByLabel('Python 包源').selectOption('https://mirrors.aliyun.com/pypi/simple'); await name.fill('mcp-server-time'); await version.fill('2026.10.28');
  await page.getByRole('button', { name: '安装', exact: true }).click();
  await expect(page.getByRole('button', { name: '安装', exact: true })).toBeEnabled({ timeout: 615000 });
  await expect(page.getByRole('status')).toContainText('已安装 mcp-server-time');
  packages = await native('mcp_packages');
  const python = packages.find(item => item.ecosystem === 'python' && !before.some(old => old.id === item.id));
  expect(python?.name).toBe('mcp-server-time'); installed.push(python.id);
  const pythonConfig = { connectionId: crypto.randomUUID(), installationId: python.id, entryPoint: python.entryPoints[0], args: [] };
  const pythonTools = await native('mcp_discover', { sessionId, requestId: crypto.randomUUID(), config: pythonConfig, env });
  expect(pythonTools.some(item => item.name === 'get_current_time')).toBe(true);
  await native('mcp_approve', { sessionId, config: pythonConfig, tools: ['get_current_time'] });
  const time = await native('mcp_call', { sessionId, requestId: crypto.randomUUID(), config: pythonConfig, env, tool: 'get_current_time', arguments: { timezone: 'Asia/Shanghai' } });
  expect(JSON.stringify(time)).toContain('Asia/Shanghai');
  await native('mcp_disconnect', { sessionId });
  mark('actual UI Python wheel install and real Python stdio tool call');
  const packageRoot = path.join(process.env.LOCALAPPDATA, 'com.geiit.agents.dev', 'mcp-packages');
  const directoriesBeforeCancel = (await readdir(packageRoot)).sort();
  await kind.selectOption('npm'); await name.fill('@modelcontextprotocol/server-filesystem'); await version.fill('2.1.0');
  await page.getByRole('button', { name: '安装', exact: true }).click();
  await expect(page.getByRole('button', { name: '取消安装', exact: true })).toBeVisible();
  expect(await rejection(native('mcp_install', { requestId: crypto.randomUUID(), ecosystem: 'npm', name: '@modelcontextprotocol/server-filesystem', version: '2.1.0', registry: 'https://registry.npmjs.org' }))).toContain('MCP_BUSY');
  await page.getByRole('button', { name: '取消安装', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已取消');
  await expect(page.getByRole('button', { name: '安装', exact: true })).toBeEnabled();
  await expect.poll(async () => (await readdir(packageRoot)).sort(), { timeout: 15000 }).toEqual(directoriesBeforeCancel);
  mark('concurrent installation returns busy; UI cancellation removes the staging directory');
  for (const dark of [false, true]) for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), dark);
    const help = page.getByRole('button', { name: '包安装安全与要求说明' });
    await help.click(); await expect(page.getByRole('tooltip')).toBeVisible();
    const bounds = await page.getByRole('tooltip').boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
    await page.screenshot({ path: path.join(output, `mcp-${width}-${dark ? 'dark' : 'light'}.png`) });
    await page.keyboard.press('Escape'); await expect(page.getByRole('tooltip')).toHaveCount(0);
  }
  mark('light/dark 390px and 1280px tooltips remain readable within the viewport');
  const help = page.getByRole('button', { name: '包安装安全与要求说明' });
  await help.blur();
  await help.focus(); await expect(page.getByRole('tooltip')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.getByRole('tooltip')).toHaveCount(0);
  await page.mouse.move(0, 0);
  await help.hover(); await expect(page.getByRole('tooltip')).toBeVisible();
  await page.mouse.move(0, 0); await help.blur(); await expect(page.getByRole('tooltip')).toHaveCount(0);
  mark('tooltip keyboard focus, hover and Escape behavior');
  await page.evaluate(() => { const frame = document.createElement('iframe'); frame.id = 'mcp-preview'; frame.sandbox = 'allow-scripts'; frame.src = 'http://geiit-preview.localhost/web-preview.html'; document.body.append(frame); });
  await expect(page.frameLocator('#mcp-preview').locator('body')).toBeAttached();
  const denied = await page.frameLocator('#mcp-preview').locator('body').evaluate(async () => { try { await window.__TAURI_INTERNALS__.invoke('mcp_packages'); return false; } catch (error) { return String(error).includes('unavailable in previews'); } });
  expect(denied).toBe(true); mark('preview iframe cannot install or launch local tools');
  await native('mcp_lock');
  for (const installationId of installed) await native('mcp_remove', { installationId });
  expect((await native('mcp_packages')).map(item => item.id).sort()).toEqual(before.map(item => item.id).sort());
  installed.length = 0; mark('only test packages removed; existing package list preserved');
  const orphanId = crypto.randomUUID(), orphanPath = path.join(packageRoot, orphanId);
  await mkdir(orphanPath); await writeFile(path.join(orphanPath, 'partial-download'), 'synthetic staging data');
  expect((await native('mcp_packages')).map(item => item.id).sort()).toEqual(before.map(item => item.id).sort());
  expect((await readdir(packageRoot)).includes(orphanId)).toBe(false);
  mark('package inventory removes an interrupted staging directory only while installs are idle');
  expect(errors).toEqual([]);
  const binary = await readFile(exe);
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, checks, errors, binary: { bytes: binary.length, sha256: createHash('sha256').update(binary).digest('hex') }, syntheticModelRequests: modelRequests, realModelRequests: 0 }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, output, errors }));
} catch (error) {
  if (page) { await bounded(page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true })).catch(() => {}); }
  await writeFile(path.join(output, 'error.json'), JSON.stringify({ error: String(error), checks, errors }, null, 2));
  throw error;
} finally {
  if (page) {
    await bounded(native('mcp_lock')).catch(() => {});
    const current = await bounded(native('mcp_packages')).catch(() => []);
    const newIds = new Set([...installed, ...current.filter(item => !before.some(old => old.id === item.id)).map(item => item.id)]);
    for (const installationId of newIds) await bounded(native('mcp_remove', { installationId })).catch(() => {});
  }
  if (app.pid && app.exitCode === null) await new Promise(resolve => { const stop = spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); stop.on('error', resolve); stop.on('exit', resolve); });
  if (browser) await bounded(browser.close()).catch(() => {});
  modelServer.closeAllConnections();
  await new Promise(resolve => modelServer.close(resolve));
}
