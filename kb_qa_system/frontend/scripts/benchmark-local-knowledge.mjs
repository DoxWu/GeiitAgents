// Reproducible local-only benchmark. Run against a production preview; no chat model or business API is used.
import { chromium, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fixtureVersion, makeCorpus, questions as fixtureQuestions } from './fixtures/local-kb-benchmark.mjs';

const run = promisify(execFile);
const baseUrl = process.env.LOCAL_KB_BENCH_URL || 'http://127.0.0.1:1423';
const scale = process.env.LOCAL_KB_BENCH_SCALE === 'small' ? 'small' : 'standard';
const rounds = Math.max(1, Math.min(5, Number(process.env.LOCAL_KB_BENCH_ROUNDS) || 2));
const datasetMode = process.env.LOCAL_KB_BENCH_DATASET === 'multi-cpr-sample';
const datasetDir = path.resolve(process.env.LOCAL_KB_BENCH_DATASET_DIR || '../../.tools/multi-cpr-review-sample');
const root = path.resolve('../../.tools/local-knowledge-benchmark', datasetMode ? 'multi-cpr-sample' : '');
const profile = path.resolve(process.env.LOCAL_KB_BENCH_PROFILE
  || (datasetMode ? '../../.tools/local-knowledge-benchmark/multi-cpr-browser-profile' : '../../.tools/local-knowledge-qa/browser-profile'));
await mkdir(root, { recursive: true });
const launchedAfter = new Date(Date.now() - 2000).toISOString();
const startedAt = new Date().toISOString();
const documents = datasetMode ? await loadMultiCprDocuments(datasetDir) : makeCorpus(scale);
const documentByName = new Map(documents.map(document => [document.name, document.text]));
const evaluationCases = datasetMode ? await loadMultiCprQuestions(datasetDir, documents) : fixtureQuestions.map(question => ({
  id: question.id, group: question.language, question: question.question, label: 'retrieval-positive',
  goldDocumentNames: question.relevant.map(source => source.name),
}));
if (documentByName.size !== documents.length || evaluationCases.some(item => item.label === 'retrieval-positive'
  && item.goldDocumentNames.some(name => !documentByName.has(name)))) {
  throw new Error('Benchmark fixture labels do not match the generated corpus.');
}
if (!datasetMode && fixtureQuestions.some(question => question.relevant.some(source =>
  !documentByName.get(source.name)?.includes(source.evidence)))) {
  throw new Error('Synthetic benchmark evidence does not match the generated corpus.');
}
const benchmarkVersion = datasetMode ? 'multi-cpr-selected-30-v1' : fixtureVersion;
const results = { schemaVersion: 1, fixtureVersion: benchmarkVersion, startedAt, scale, rounds,
  dataset: datasetMode ? { name: 'Multi-CPR selected sample', directory: datasetDir,
    documents: documents.length, retrievalPositiveQueries: evaluationCases.filter(item => item.label === 'retrieval-positive').length,
    unanswerableCandidates: evaluationCases.filter(item => item.label === 'unanswerable-selected-30').length,
    scope: 'selected-30', modelCalls: 'local embeddings only; no chat model' } : { name: fixtureVersion },
  environment: { platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model || 'unknown', logicalCpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(), browser: 'Playwright Chromium', inference: 'Transformers.js WASM CPU, one thread' },
  corpus: {}, model: {}, timing: {}, quality: {}, memory: {}, storage: {}, isolation: {}, limitations: [] };

async function readJsonl(file) {
  const source = await readFile(file, 'utf8');
  return source.split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`Invalid JSONL at ${file}:${index + 1}`); }
  });
}

async function loadMultiCprDocuments(directory) {
  const rows = await readJsonl(path.join(directory, 'documents.jsonl'));
  const documents = rows.map(row => {
    if (!row.doc_id || !row.text?.trim()) throw new Error('Multi-CPR documents require doc_id and text.');
    return { id: row.doc_id, name: `${row.doc_id}.txt`, text: row.text };
  });
  const totalBytes = documents.reduce((sum, document) => sum + Buffer.byteLength(document.text, 'utf8'), 0);
  if (documents.length > 100 || totalBytes > 10 * 1024 * 1024
    || documents.some(document => Buffer.byteLength(document.text, 'utf8') > 2 * 1024 * 1024)) {
    throw new Error('The selected corpus exceeds local knowledge limits (100 files, 10 MiB total text, 2 MiB per file).');
  }
  return documents;
}

async function loadMultiCprQuestions(directory, documents) {
  const positives = await readJsonl(path.join(directory, 'positive-retrieval-examples.jsonl'));
  const negatives = await readJsonl(path.join(directory, 'unanswerable-examples.jsonl'));
  const names = new Map(documents.map(document => [document.id, document.name]));
  const ids = new Set();
  const cases = [
    ...positives.map(row => {
      if (!row.sample_id || !row.query?.trim() || !names.has(row.gold_doc_id) || row.relevance !== 1
        || !['ecom', 'video', 'medical'].includes(row.domain)) throw new Error('Invalid positive Multi-CPR example.');
      return { id: row.sample_id, group: row.domain, question: row.query, label: 'retrieval-positive', goldDocumentNames: [names.get(row.gold_doc_id)] };
    }),
    ...negatives.map(row => {
      if (!row.query_id || !row.question?.trim() || row.answerable !== false || row.scope !== 'selected-30'
        || !Array.isArray(row.gold_evidence) || row.gold_evidence.length
        || !['ecom', 'video', 'medical'].includes(row.domain)) throw new Error('Invalid unanswerable Multi-CPR example.');
      return { id: row.query_id, group: row.domain, question: row.question, label: 'unanswerable-selected-30', goldDocumentNames: [] };
    }),
  ];
  for (const item of cases) {
    if (ids.has(item.id)) throw new Error(`Duplicate Multi-CPR query id: ${item.id}`);
    ids.add(item.id);
  }
  if (!positives.length || !negatives.length) throw new Error('Multi-CPR evaluation requires positive and unanswerable examples.');
  return cases;
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}

function summarizeRetrieval(rows) {
  const count = rows.length;
  const rankOf = row => row.goldDocumentNames.map(name => row.ranked.indexOf(name)).filter(rank => rank >= 0)
    .reduce((best, rank) => Math.min(best, rank), Infinity);
  const reciprocal = row => { const rank = rankOf(row); return Number.isFinite(rank) ? 1 / (rank + 1) : 0; };
  return { questions: count,
    recallAt1: rows.filter(row => rankOf(row) < 1).length / count,
    recallAt5: rows.filter(row => rankOf(row) < 5).length / count,
    mrr: rows.reduce((sum, row) => sum + reciprocal(row), 0) / count,
    ndcgAt5: rows.reduce((sum, row) => { const rank = rankOf(row); return sum + (rank < 5 ? 1 / Math.log2(rank + 2) : 0); }, 0) / count,
    failures: rows.filter(row => !Number.isFinite(rankOf(row))).map(row => ({ id: row.id, question: row.question, ranked: row.ranked })) };
}

function compareScoreCutRates(positiveRows, negativeRows) {
  const scores = [...positiveRows, ...negativeRows].map(row => row.topScore).filter(Number.isFinite);
  if (!positiveRows.length || !negativeRows.length || !scores.length) throw new Error('Score comparison requires scored retrieval-positive and unanswerable examples.');
  const min = Math.min(...scores), max = Math.max(...scores);
  const thresholds = [...new Set([min - 0.001, ...scores, max + 0.001])].sort((a, b) => a - b);
  const rates = thresholds.map(threshold => ({ threshold: Number(threshold.toFixed(6)),
    retrievalPositiveQueryRateAboveCut: positiveRows.filter(row => row.topScore >= threshold).length / positiveRows.length,
    unanswerableCandidateRateAboveCut: negativeRows.filter(row => row.topScore >= threshold).length / negativeRows.length }));
  return { scoreSource: 'UI-displayed cosine score rounded to 0.001', rates,
    caveat: 'Descriptive score comparison only. Retrieval relevance labels are not answerability labels; these groups cannot calibrate a refusal threshold.' };
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

const requests = [], apiAttempts = [], externalAttempts = [], pageErrors = [];
const sourceOrigin = new URL(baseUrl).origin;
const context = await chromium.launchPersistentContext(profile, { headless: true, serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
await context.addInitScript(() => { try { localStorage.clear(); } catch { /* about:blank has no storage origin */ } });
const page = await context.newPage();
for (const old of context.pages()) if (old !== page) await old.close();
context.on('request', request => requests.push(request.url()));
await context.route('**/*', route => {
  const requestUrl = new URL(route.request().url());
  if (requestUrl.origin !== sourceOrigin) {
    externalAttempts.push(`${route.request().method()} ${requestUrl.origin}`);
    return route.abort();
  }
  if (requestUrl.pathname.startsWith('/api/v1/')) {
    apiAttempts.push(`${route.request().method()} ${requestUrl.pathname}`);
    return route.abort();
  }
  return route.continue();
});
page.on('pageerror', error => pageErrors.push(error.message));
const interval = setInterval(() => void sampleMemory('periodic'), 2000);
try {
  await page.goto(`${baseUrl}/local-knowledge`);
  await page.evaluate(async () => {
    localStorage.clear();
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
  Object.assign(results.corpus, indexStats, { questionCount: evaluationCases.length });
  results.timing.indexMsPer100Chunks = Math.round(results.timing.indexMs / indexStats.chunks * 100);
  const estimate = await page.evaluate(() => navigator.storage.estimate());
  results.storage = { originUsageBytes: estimate.usage ?? null, originQuotaBytes: estimate.quota ?? null,
    note: 'Origin usage includes the verified model cache, IndexedDB index, and browser overhead.' };

  const latency = [], judgments = [];
  for (let round = 0; round < rounds; round++) {
    for (const item of evaluationCases) {
      const began = performance.now();
      await page.getByLabel('本地检索问题').fill(item.question);
      const searchButton = page.getByRole('button', { name: '本地检索', exact: true });
      await searchButton.click();
      await expect(page.getByRole('status').first()).toContainText('检索完成', { timeout: 60000 });
      await expect(searchButton).toBeEnabled({ timeout: 5000 });
      const elapsed = performance.now() - began;
      latency.push(elapsed);
      const hits = await page.locator('.lk-search > article.lk-hit').evaluateAll(elements => elements.map(element => ({
        name: element.querySelector('strong')?.textContent?.replace(/^\d+\.\s*/, '') ?? '',
        score: Number(element.querySelector('span')?.textContent?.match(/-?\d+(?:\.\d+)?/)?.[0]),
      })));
      const ranked = hits.map(hit => hit.name);
      if (round === 0) judgments.push({ id: item.id, group: item.group, question: item.question,
        label: item.label, goldDocumentNames: item.goldDocumentNames, ranked, topScore: hits[0]?.score ?? null,
        hitAt1: item.goldDocumentNames.some(name => ranked[0] === name),
        hitAt5: item.goldDocumentNames.some(name => ranked.slice(0, 5).includes(name)) });
    }
  }
  const count = judgments.length;
  results.timing.querySamples = latency.length;
  results.timing.queryP50Ms = Math.round(percentile(latency, 0.5));
  results.timing.queryP95Ms = Math.round(percentile(latency, 0.95));
  results.timing.queryMaxMs = Math.round(Math.max(...latency));
  if (datasetMode) {
    const positives = judgments.filter(row => row.label === 'retrieval-positive');
    const negatives = judgments.filter(row => row.label === 'unanswerable-selected-30');
    const negativeScores = negatives.map(row => row.topScore).filter(Number.isFinite);
    const scoreComparison = compareScoreCutRates(positives, negatives);
    const summarizeDomain = domain => {
      const positiveRows = positives.filter(row => row.group === domain);
      const negativeRows = negatives.filter(row => row.group === domain);
      return { positiveRetrieval: summarizeRetrieval(positiveRows), unanswerableCandidates: {
        questions: negativeRows.length,
        topScore: negativeRows.length ? {
          min: Math.min(...negativeRows.map(row => row.topScore)),
          max: Math.max(...negativeRows.map(row => row.topScore)),
        } : null,
      } };
    };
    results.quality = {
      positiveRetrieval: summarizeRetrieval(positives),
      unanswerableCandidates: { questions: negatives.length,
        topScore: { min: Math.min(...negativeScores), p50: percentile(negativeScores, 0.5),
          p95: percentile(negativeScores, 0.95), max: Math.max(...negativeScores) },
        highestScoreCases: [...negatives].sort((a, b) => b.topScore - a.topScore).slice(0, 5)
          .map(({ id, group, question, topScore, ranked }) => ({ id, group, question, topScore, ranked })) },
      byDomain: Object.fromEntries(['ecom', 'video', 'medical'].map(domain => [domain, summarizeDomain(domain)])),
      descriptiveScoreCutRates: scoreComparison,
      judgments,
    };
  } else {
    results.quality = { labeledQuestions: count,
      recallAt1: judgments.filter(j => j.hitAt1).length / count, recallAt5: judgments.filter(j => j.hitAt5).length / count,
      byLanguage: Object.fromEntries(['zh', 'en-to-zh'].map(language => {
        const group = judgments.filter(j => j.group === language);
        return [language, { questions: group.length, recallAt1: group.filter(j => j.hitAt1).length / group.length, recallAt5: group.filter(j => j.hitAt5).length / group.length }];
      })), failures: judgments.filter(j => !j.hitAt5) };
  }

  const scope = page.locator('.lk-search-scope');
  await scope.locator('summary').click();
  const searchButton = page.getByRole('button', { name: '本地检索', exact: true });
  await scope.getByRole('button', { name: '清空选择' }).click();
  await expect(searchButton).toBeDisabled();
  await expect(page.locator('.lk-search > article.lk-hit')).toHaveCount(0);
  const positive = evaluationCases.find(item => item.label === 'retrieval-positive');
  const selectedName = positive.goldDocumentNames[0];
  await scope.getByRole('checkbox', { name: selectedName }).check();
  await page.getByLabel('本地检索问题').fill(positive.question);
  await searchButton.click();
  await expect(page.getByRole('status').first()).toContainText('检索完成', { timeout: 60000 });
  await expect(searchButton).toBeEnabled({ timeout: 5000 });
  const scopedNames = await page.locator('.lk-search > article.lk-hit strong').allTextContents();
  const scopedResultsValid = scopedNames.length > 0 && scopedNames.every(name => name.replace(/^\d+\.\s*/, '') === selectedName);
  if (!scopedResultsValid) throw new Error(`File scope returned unexpected results: ${JSON.stringify(scopedNames)}`);
  await scope.getByRole('checkbox', { name: selectedName }).uncheck();
  await expect(page.locator('.lk-search > article.lk-hit')).toHaveCount(0);
  await expect(searchButton).toBeDisabled();
  await scope.getByRole('button', { name: '搜索全部文件' }).click();
  await expect(searchButton).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileLayout = await page.evaluate(() => ({ viewportWidth: innerWidth,
    documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth }));
  results.scopeVerification = { noSelectionDisablesSearch: true, staleResultsClearOnScopeChange: true,
    selectedFile: selectedName, selectedFileOnlyResults: scopedNames.length, allFilesCanBeRestored: true, mobileLayout };
  if (mobileLayout.documentWidth > mobileLayout.viewportWidth || mobileLayout.bodyWidth > mobileLayout.viewportWidth) {
    throw new Error(`Local knowledge page overflows at 390px: ${JSON.stringify(mobileLayout)}`);
  }
  await sampleMemory('queries-complete');
  await page.screenshot({ path: path.join(root, 'benchmark-results.png'), fullPage: true });
  results.isolation = { businessApiRequests: apiAttempts.length, businessApiPaths: apiAttempts,
    externalRequests: externalAttempts, externalRequestAttempts: externalAttempts.length,
    modelNetworkRequests: requests.filter(url => /huggingface\.co|hf\.co/.test(url)).length, pageErrors };
  console.log('Isolation checks:', JSON.stringify(results.isolation));
  expect(results.isolation.businessApiRequests).toBe(0);
  expect(results.isolation.externalRequestAttempts).toBe(0);
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
results.limitations = datasetMode ? [
  'This is a 30-document selected sample, not the full Multi-CPR corpus or representative business data.',
  'Positive labels are retrieval relevance judgments, not answerability judgments; they contain one selected relevant passage per query.',
  'Unanswerable labels are user-authored and scoped only to selected-30; they do not assert absence from larger corpora or reality.',
  'Threshold analysis is exploratory and does not alter product behavior or calibrate a business refusal threshold.',
  'The supplied archive did not include a data license; sample output remains local and is not suitable for redistribution.',
] : [
  'Synthetic deterministic relevance set; Recall@5 is not a production corpus quality claim.',
  'Current machine is not the planned 8 GB low-end acceptance device.',
  'Memory is process-level sampled working set, not an exact allocation trace.',
  'Index build is sequential to cap memory; the benchmark does not test interruption/resume or 2,000 chunks exactly.',
];
const file = path.join(root, `result-${startedAt.replace(/[:.]/g, '-')}.json`);
await writeFile(file, JSON.stringify(results, null, 2));
await writeFile(path.join(root, 'latest.json'), JSON.stringify(results, null, 2));
const qualitySummary = datasetMode ? {
  positiveRetrieval: results.quality.positiveRetrieval,
  unanswerableCandidates: results.quality.unanswerableCandidates,
  byDomain: results.quality.byDomain,
  descriptiveScoreCutRates: results.quality.descriptiveScoreCutRates,
} : results.quality;
console.log(JSON.stringify({ file, corpus: results.corpus, timing: results.timing, quality: qualitySummary, memory: results.memory }, null, 2));
