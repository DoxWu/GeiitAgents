import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createCipheriv, pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeVaultCiphertext, readVaultCiphertext } from './vault-qa.mjs';

const output = path.resolve('../../.tools/long-conversations-qa');
await mkdir(output, { recursive: true });
const password = 'synthetic-chat-1234', now = new Date().toISOString();
const profile = { id: randomUUID(), name: 'Synthetic local model', mode: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', apiKey: '' };
function conversation(title, count) {
  return { id: randomUUID(), title, profileId: profile.id, updatedAt: now,
    messages: Array.from({ length: count }, (_, index) => ({ id: randomUUID(), role: index % 2 ? 'assistant' : 'user',
      content: `${title} message ${index}\n\n${'Synthetic body for scroll validation. '.repeat(8)}`, createdAt: now })) };
}
const long = conversation('Long history', 45), second = conversation('Second history', 30);
function seal(data) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', pbkdf2Sync(password, salt, 600000, 32, 'sha256'), iv);
  cipher.setAAD(Buffer.from('geiit-private-workbench-v1'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({ version: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64') });
}
const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const url = `http://127.0.0.1:${port}/workbench`;
let preview, browser, page;
const errors = [], calls = [];
try {
  preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort', '--configLoader', 'runner'], { windowsHide: true, stdio: 'ignore' });
  let launchError; preview.on('error', error => { launchError = error; });
  await expect.poll(async () => { if (launchError) throw launchError; try { return (await fetch(url)).ok; } catch { return false; } }, { timeout: 15000 }).toBe(true);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await context.route('**/api/v1/**', route => route.fulfill({ json: {} }));
  await context.routeWebSocket('**/ws/notifications', () => {});
  await context.route('http://127.0.0.1:11434/v1/chat/completions', route => {
    calls.push(route.request().postDataJSON());
    return route.fulfill({ json: { choices: [{ message: { content: 'Synthetic new answer' }, finish_reason: 'stop' }] }, headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  const button = name => page.getByRole('button', { name, exact: true });
  await page.goto(url);
  await writeVaultCiphertext(page, seal({ profiles: [profile], conversations: [long, second] }));
  await page.reload();
  await page.getByLabel('解锁口令', { exact: true }).fill(password); await button('解锁').click();
  const articles = page.locator('main article');
  await expect(articles).toHaveCount(20);
  await expect(articles.first()).toContainText('Long history message 25');
  const original = await readVaultCiphertext(page);
  await button('加载更早的消息').scrollIntoViewIfNeeded();
  const anchor = page.getByText('Long history message 25', { exact: true });
  const before = await anchor.boundingBox();
  await button('加载更早的消息').click(); await expect(articles).toHaveCount(40);
  const after = await page.getByText('Long history message 25', { exact: true }).boundingBox();
  expect(before).not.toBeNull(); expect(after).not.toBeNull();
  expect(Math.abs(after.y - before.y)).toBeLessThan(2);
  const scroller = page.getByTestId('chat-message-scroll-region');
  expect(await scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await scroller.evaluate(element => { element.scrollTop = 0; });
  const marker = page.getByText('Long history message 5', { exact: true });
  const markerBefore = await marker.boundingBox();
  await button('加载更早的消息').click(); await expect(articles).toHaveCount(45);
  const markerAfter = await marker.boundingBox();
  expect(Math.abs(markerAfter.y - markerBefore.y)).toBeLessThan(2);
  expect(await readVaultCiphertext(page)).toBe(original);
  await button('Second history').click(); await expect(articles).toHaveCount(20);
  await expect(articles.first()).toContainText('Second history message 10');
  await button('Long history').click(); await expect(articles).toHaveCount(20);
  const downloadEvent = page.waitForEvent('download'); await button('导出 Markdown').click();
  const download = await downloadEvent, destination = path.join(output, 'long-history.md'); await download.saveAs(destination);
  const markdown = await readFile(destination, 'utf8');
  for (const message of long.messages) expect(markdown).toContain(message.content);
  await page.getByLabel('消息', { exact: true }).fill('Next question'); await button('发送').click();
  await expect(page.getByRole('status').filter({ hasText: '模型处理中' })).toBeHidden();
  await expect(page.getByText('Synthetic new answer', { exact: true })).toHaveCount(1);
  expect(calls).toHaveLength(1);
  expect(calls[0].messages).toEqual([...long.messages.map(({ role, content }) => ({ role, content })), { role: 'user', content: 'Next question' }]);
  await expect(articles).toHaveCount(20);
  await page.screenshot({ path: path.join(output, 'desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, 'mobile.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload(); await page.getByLabel('解锁口令', { exact: true }).fill(password); await button('解锁').click();
  await expect(articles).toHaveCount(20); await expect(page.getByText('Synthetic new answer', { exact: true })).toHaveCount(1);
  expect(errors).toEqual([]);
  const result = { passed: true, messagesBefore: 45, messagesAfter: 47, initialRendered: 20, modelRequests: calls.length, exportedMessages: long.messages.length, scrollAnchorDeltaPx: markerAfter.y - markerBefore.y, pageErrors: errors };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); throw error;
} finally { await browser?.close(); preview?.kill(); }
