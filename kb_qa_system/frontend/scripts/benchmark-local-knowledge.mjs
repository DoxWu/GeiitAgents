// Reproducible local-only benchmark. Run against a production preview; no chat model or business API is used.
import { chromium, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fixtureVersion, makeCorpus, questions } from './fixtures/local-kb-benchmark.mjs';

const run = promisify(execFile);
const baseUrl = process.env.LOCAL_KB_BENCH_URL || 'http://127.0.0.1:1423';
const scale = process.env.LOCAL_KB_BENCH_SCALE === 'small' ? 'small' : 'standard';
const rounds = Math.max(1, Math.min(5, Number(process.env.LOCAL_KB_BENCH_ROUNDS) || 2));
const root = path.resolve('../../.tools/local-knowledge-benchmark');
const profile = path.resolve('../../.tools/local-knowledge-qa/browser-profile');
await mkdir(root, { recursive: true });
const launchedAfter = new Date(Date.now() - 2000).toISOString();
const startedAt = new Date().toISOString();
const documents = makeCorpus(scale);
const documentByName = new Map(documents.map(document => [document.name, document.text]));
if (documentByName.size !== documents.length || questions.some(question => question.relevant.some(source => !documentByName.get(source.name)?.includes(source.evidence)))) {
  throw new Error('Benchmark fixture labels do not match the generated corpus.');
}
const results = { schemaVersion: 1, fixtureVersion, startedAt, scale, rounds,
  environment: { platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model || 'unknown', logicalCpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(), browser: 'Playwright Chromium', inference: 'Transformers.js WASM CPU, one thread' },
  corpus: {}, model: {}, timing: {}, quality: {}, memory: {}, storage: {}, isolation: {}, limitations: [] };

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}
async function processMemory() {
  if (process.platform !== 'win32') return null;
  const script = `$cutoff=[datetime]::Parse($env:GEIIT_BENCH_START); $p=@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^chrome(-headless-shell)?$' -and $_.StartTime -ge $cutoff }); [pscustomobject]@{processCount=$p.Count;workingSetBytes=($p|Measure-Object WorkingSet64 -Sum).Sum;privateBytes=($p|Measure-Object PrivateMemorySize64 -Sum).Sum}|ConvertTo-Json -Compress`;
  try {
    const { stdout } = await run('powershell', ['-NoProfile', '-Command', script], { env: { ...process.env, GEIIT_BENCH_START: launchedAfter }, windowsHide: true });
    const value = JSON.parse(stdout.trim());
    return { processCount: Number(value.processCount || 0), workingSetBytes: Number(value.workingSetBytes || 0), privateBytes: Number(value.privateBytes || 0) };
  } catch { return null; }
}
const samples = [];
let sampling = false;
async function sampleMemory(stage) {
  if (sampling) return;
  sampling = true;
  try { const value = await processMemory(); if (value) samples.push({ at: new Date().toISOString(), stage, ...value }); }
  finally { sampling = false; }
}

const requests = [], pageErrors = [];
const context = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
for (const old of context.pages()) if (old !== page) await old.close();
context.on('request', request => requests.push(request.url()));
page.on('pageerror', error => pageErrors.push(error.message));
const interval = setInterval(() => void sampleMemory('periodic'), 2000);
try {
  await page.goto(`${baseUrl}/local-knowledge`);
  await page.evaluate(async () => {
    await new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase('geiit-local-knowledge-v1'); request.onsuccess = resolve; request.onerror = reject; request.onblocked = reject; });
  });
  await page.reload();
  const cacheEntries = await page.evaluate(async () => (await (await caches.open('geiit-local-models-v1')).keys()).length);
  if (!cacheEntries) throw new Error('Default E5 cache is empty. Run the opt-in local knowledge verification once before benchmarking.');
  results.model.cacheEntries = cacheEntries;
  await sampleMemory('before-enable');
  const enableStart = performance.now();
  await page.getByRole('button', { name: '启用模型 / 按配置重建' }).click();
  await expect(page.getByRole('button', { name: '选择文件并建立索引' })).toBeEnabled({ timeout: 180000 });
  results.timing.cachedEnableMs = Math.round(performance.now() - enableStart);
  await sampleMemory('model-ready');

  const files = documents.map(document => ({ name: document.name, mimeType: document.name.endsWith('.md') ? 'text/markdown' : 'text/plain', buffer: Buffer.from(document.text) }));
  const indexStart = performance.now();
  await page.getByLabel('选择本地文档').setInputFiles(files);
  const progress = setInterval(async () => console.log('Benchmark:', await page.getByRole('status').first().textContent().catch(() => 'waiting')), 30000);
  try { await Promise.race([
    expect(page.getByRole('status').first()).toContainText('导入完成', { timeout: 900000 }),
    page.getByRole('alert').first().waitFor({ state: 'visible', timeout: 900000 }).then(async () => { throw new Error(await page.getByRole('alert').first().innerText()); }),
  ]); } finally { clearInterval(progress); }
  results.timing.indexMs = Math.round(performance.now() - indexStart);
  await sampleMemory('index-complete');

  const indexStats = await page.evaluate(async () => new Promise((resolve, reject) => {
    const request = indexedDB.open('geiit-local-knowledge-v1');
    request.onerror = reject;
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('index'), get = tx.objectStore('index').get('active');
      get.onerror = reject;
      get.onsuccess = () => {
        const index = get.result;
        const textBytes = index.documents.reduce((sum, document) => sum + document.bytes, 0);
        resolve({ documents: index.documents.length, chunks: index.chunks.length, textBytes,
          rawVectorBytes: index.chunks.reduce((sum, chunk) => sum + chunk.vector.length * 4, 0), dimensions: index.profile.dimensions });
        db.close();
      };
    };
  }));
  Object.assign(results.corpus, indexStats, { questionCount: questions.length });
  results.timing.indexMsPer100Chunks = Math.round(results.timing.indexMs / indexStats.chunks * 100);
  const estimate = await page.evaluate(() => navigator.storage.estimate());
  results.storage = { originUsageBytes: estimate.usage ?? null, originQuotaBytes: estimate.quota ?? null,
    note: 'Origin usage includes the verified model cache, IndexedDB index, and browser overhead.' };

  const latency = [], judgments = [];
  for (let round = 0; round < rounds; round++) {
    for (const item of questions) {
      const began = performance.now();
      await page.getByLabel('本地检索问题').fill(item.question);
      await page.getByRole('button', { name: '本地检索', exact: true }).click();
      await expect(page.getByRole('status').first()).toContainText('正在本机检索', { timeout: 5000 });
      await expect(page.getByRole('status').first()).toContainText('检索完成', { timeout: 60000 });
      const elapsed = performance.now() - began;
      latency.push(elapsed);
      const names = await page.locator('.lk-search > .lk-hit > div > strong').allTextContents();
      const ranked = names.map(name => name.replace(/^\d+\.\s*/, ''));
      if (round === 0) judgments.push({ id: item.id, language: item.language, expected: item.relevant.map(r => r.name), ranked,
        hitAt1: item.relevant.some(r => ranked[0] === r.name), hitAt5: item.relevant.some(r => ranked.includes(r.name)) });
    }
  }
  const count = judgments.length;
  results.timing.querySamples = latency.length;
  results.timing.queryP50Ms = Math.round(percentile(latency, 0.5));
  results.timing.queryP95Ms = Math.round(percentile(latency, 0.95));
  results.timing.queryMaxMs = Math.round(Math.max(...latency));
  results.quality = { labeledQuestions: count,
    recallAt1: judgments.filter(j => j.hitAt1).length / count, recallAt5: judgments.filter(j => j.hitAt5).length / count,
    byLanguage: Object.fromEntries(['zh', 'en-to-zh'].map(language => {
      const group = judgments.filter(j => j.language === language);
      return [language, { questions: group.length, recallAt1: group.filter(j => j.hitAt1).length / group.length, recallAt5: group.filter(j => j.hitAt5).length / group.length }];
    })), failures: judgments.filter(j => !j.hitAt5) };
  await sampleMemory('queries-complete');
  await page.screenshot({ path: path.join(root, 'benchmark-results.png'), fullPage: true });
  results.isolation = { businessApiRequests: requests.filter(url => url.includes('/api/v1/')).length,
    modelNetworkRequests: requests.filter(url => /huggingface\.co|hf\.co/.test(url)).length, pageErrors };
  expect(results.isolation.businessApiRequests).toBe(0);
  expect(results.isolation.modelNetworkRequests).toBe(0);
  expect(pageErrors).toEqual([]);
} finally {
  clearInterval(interval);
  await sampleMemory('before-close');
  await context.close();
}
results.finishedAt = new Date().toISOString();
if (samples.length) {
  results.memory = { method: 'Sampled total working set/private bytes of benchmark Chrome processes created after launch; 2 second interval. This includes browser/runtime overhead and may miss sub-second peaks.',
    sampleCount: samples.length, baseline: samples[0], peakWorkingSetBytes: Math.max(...samples.map(s => s.workingSetBytes)),
    peakPrivateBytes: Math.max(...samples.map(s => s.privateBytes)), final: samples.at(-1) };
} else results.memory = { method: 'Unavailable on this platform.' };
results.limitations = [
  'Synthetic deterministic relevance set; Recall@5 is not a production corpus quality claim.',
  'Current machine is not the planned 8 GB low-end acceptance device.',
  'Memory is process-level sampled working set, not an exact allocation trace.',
  'Index build is sequential to cap memory; the benchmark does not test interruption/resume or 2,000 chunks exactly.',
];
const file = path.join(root, `result-${startedAt.replace(/[:.]/g, '-')}.json`);
await writeFile(file, JSON.stringify(results, null, 2));
await writeFile(path.join(root, 'latest.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ file, corpus: results.corpus, timing: results.timing, quality: results.quality, memory: results.memory }, null, 2));
