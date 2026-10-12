import { chromium, expect, firefox, webkit } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const baseUrl = process.env.LOCAL_KB_BROWSER_SMOKE_URL || 'http://127.0.0.1:1423';
const origin = new URL(baseUrl).origin;
const requested = (process.env.LOCAL_KB_BROWSER_SMOKE_BROWSERS || 'chromium,edge,firefox,webkit')
  .split(',').map(name => name.trim().toLowerCase()).filter(Boolean);
const browserTypes = { chromium, edge: chromium, firefox, webkit };
const outputDir = path.resolve('../../.tools');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = path.join(outputDir, `browser-compat-smoke-${timestamp}.json`);
await mkdir(outputDir, { recursive: true });

async function probeBrowserApis(page) {
  return page.evaluate(async () => {
    const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
    const idbName = `geiit-browser-smoke-${crypto.randomUUID()}`;
    const indexedDbRoundTrip = await new Promise(resolve => {
      const opening = indexedDB.open(idbName, 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore('probe');
      opening.onerror = () => resolve(false);
      opening.onsuccess = () => {
        const db = opening.result;
        const transaction = db.transaction('probe', 'readwrite');
        transaction.objectStore('probe').put('ok', 'key');
        transaction.oncomplete = () => {
          db.close();
          const deleting = indexedDB.deleteDatabase(idbName);
          deleting.onsuccess = () => resolve(true);
          deleting.onerror = () => resolve(false);
        };
        transaction.onerror = () => { db.close(); resolve(false); };
      };
    });
    const workerRoundTrip = await new Promise(resolve => {
      const blob = new Blob(['onmessage=()=>postMessage("ok")'], { type: 'text/javascript' });
      const url = URL.createObjectURL(blob);
      const worker = new Worker(url);
      const timeout = setTimeout(() => finish(false), 3000);
      const finish = value => { clearTimeout(timeout); worker.terminate(); URL.revokeObjectURL(url); resolve(value); };
      worker.onmessage = event => finish(event.data === 'ok');
      worker.onerror = () => finish(false);
      worker.postMessage('probe');
    });
    let cacheStorage = false;
    if ('caches' in globalThis) {
      const cacheName = `geiit-browser-smoke-${crypto.randomUUID()}`;
      try { await caches.open(cacheName); cacheStorage = await caches.delete(cacheName); } catch { cacheStorage = false; }
    }
    let cryptoSubtle = false;
    try { cryptoSubtle = (await crypto.subtle.digest('SHA-256', new Uint8Array([1]))).byteLength === 32; }
    catch { cryptoSubtle = false; }
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    return {
      indexedDbRoundTrip,
      workerRoundTrip,
      cryptoSubtle,
      webAssembly: WebAssembly.validate(bytes),
      cacheStorage,
      webLocks: Boolean(navigator.locks?.request),
      storageEstimate: typeof navigator.storage?.estimate === 'function',
      storagePersist: typeof navigator.storage?.persist === 'function',
      abortSignalAny: typeof AbortSignal.any === 'function',
      fileInput: fileInput.type === 'file',
    };
  });
}

const results = [];
for (const name of requested) {
  const type = browserTypes[name];
  if (!type) throw new Error(`Unknown browser '${name}'. Use chromium, edge, firefox, or webkit.`);
  const launchOptions = { headless: true };
  if (name === 'edge') launchOptions.channel = 'msedge';
  const browser = await type.launch(launchOptions);
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const externalAttempts = [], apiAttempts = [], pageErrors = [];
    await context.route('**/*', route => {
      const requestUrl = new URL(route.request().url());
      if (/^https?:$/.test(requestUrl.protocol) && requestUrl.origin !== origin) {
        externalAttempts.push(`${route.request().method()} ${requestUrl.origin}`);
        return route.abort();
      }
      if (requestUrl.origin === origin && requestUrl.pathname.startsWith('/api/v1/')) {
        apiAttempts.push(`${route.request().method()} ${requestUrl.pathname}`);
        return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    const response = await page.goto(`${baseUrl}/local-knowledge`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: '本地知识库' })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: '启用模型 / 按配置重建' })).toBeVisible();
    const capabilities = await probeBrowserApis(page);
    const required = ['indexedDbRoundTrip', 'workerRoundTrip', 'cryptoSubtle', 'webAssembly', 'cacheStorage', 'webLocks', 'fileInput'];
    const missing = required.filter(key => !capabilities[key]);
    const layout = [];
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      layout.push(await page.evaluate(() => ({ viewportWidth: innerWidth,
        documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth })));
    }
    const result = { browser: name, version: browser.version(), httpStatus: response?.status() ?? null,
      capabilities, missingRequiredCapabilities: missing, layout, externalAttempts, apiAttempts, pageErrors };
    await page.screenshot({ path: path.join(outputDir, `browser-compat-${name}-${timestamp}.png`), fullPage: true });
    results.push(result);
    await context.close();
    if (result.httpStatus !== 200 || missing.length || layout.some(item => item.documentWidth > item.viewportWidth || item.bodyWidth > item.viewportWidth)
      || externalAttempts.length || apiAttempts.length || pageErrors.length) {
      throw new Error(`Browser smoke failed: ${JSON.stringify(result)}`);
    }
  } finally {
    await browser.close();
  }
}

const report = { generatedAt: new Date().toISOString(), platform: `${os.platform()} ${os.release()} ${os.arch()}`,
  origin, browsers: results };
await writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ reportPath, browsers: results.map(({ browser, version, capabilities, layout }) =>
  ({ browser, version, capabilities, layout })) }, null, 2));
