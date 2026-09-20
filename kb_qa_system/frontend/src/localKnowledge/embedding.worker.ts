import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers';
import wasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url';
import wasmModuleUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs?url';
import { fingerprint, LIMITS, splitText, validateProfile, validateVector, type EmbeddingProfile, type Chunk } from './core';
import { prepareResources } from './resources';
import type { Reply, Request } from './protocol';

let extractor: FeatureExtractionPipeline | null = null;
let profile: EmbeddingProfile;
let busy = false;
const reply = (message: Reply) => self.postMessage(message);
const count = (text: string) => extractor!.tokenizer.encode(text, { add_special_tokens: true }).length;
async function embed(text: string): Promise<number[]> {
  if (count(text) > profile.maxTokens) throw new Error('输入超出模型 token 上限，请缩短查询。');
  const tensor = await extractor!(text, { pooling: profile.pooling, normalize: true });
  if (tensor.dims.length !== 2 || tensor.dims[0] !== 1 || tensor.dims[1] !== profile.dimensions) throw new Error('模型输出形状不兼容，无法建立索引。');
  return validateVector(Array.from(tensor.data, Number), profile.dimensions);
}
self.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data;
  if (busy) { reply({ id: request.id, type: 'error', message: '已有本地任务在运行。' }); return; }
  busy = true;
  const report = (message: string) => reply({ id: request.id, type: 'progress', message });
  try {
    if (request.type === 'init') {
      profile = validateProfile(request.profile);
      // Transformers.js treats the verified custom cache as a local model source.
      env.allowLocalModels = true;
      env.allowRemoteModels = false;
      env.useBrowserCache = false;
      env.useFSCache = false;
      env.useCustomCache = true;
      env.customCache = await prepareResources(profile, report);
      env.backends.onnx.wasm.numThreads = 1;
      env.backends.onnx.wasm.proxy = false;
      env.backends.onnx.wasm.wasmPaths = { wasm: wasmUrl, mjs: wasmModuleUrl };
      report('正在初始化 CPU 模型并检查兼容性…');
      extractor = await pipeline<'feature-extraction'>('feature-extraction', profile.repo, {
        revision: profile.revision, dtype: profile.dtype, device: 'wasm', local_files_only: true,
      });
      const tokenizerLimit = Number(extractor.tokenizer.model_max_length);
      if (!Number.isFinite(tokenizerLimit) || profile.maxTokens > tokenizerLimit) {
        throw new Error('配置的 token 上限超过 tokenizer 支持范围，请降低 maxTokens，避免文本被截断。');
      }
      await embed(profile.queryPrefix + '本地查询 compatibility check');
      await embed(profile.passagePrefix + '本地文档 compatibility check');
      reply({ id: request.id, type: 'result', result: null });
    } else if (!extractor) throw new Error('请先启用本地模型。');
    else if (request.type === 'query') {
      if (!request.text.trim()) throw new Error('请输入查询内容。');
      reply({ id: request.id, type: 'result', result: await embed(profile.queryPrefix + request.text.trim()) });
    } else {
      const documents = request.documents;
      if (documents.length > LIMITS.documents || documents.reduce((s, d) => s + d.bytes, 0) > LIMITS.totalBytes) throw new Error('首版最多支持 100 个文件、合计 10 MiB 文本。');
      const fp = fingerprint(profile);
      const base = request.base?.fingerprint === fp ? request.base : null;
      const chunks: Chunk[] = [];
      for (let n = 0; n < documents.length; n++) {
        const document = documents[n];
        const previous = base?.documents.find(d => d.id === document.id && d.text === document.text);
        if (previous) chunks.push(...base!.chunks.filter(c => c.documentId === document.id));
        else {
          const parts = splitText(document.text, profile, count);
          if (chunks.length + parts.length > LIMITS.chunks) throw new Error('首版最多支持 2000 个片段，请减少文件。');
          for (let i = 0; i < parts.length; i++) {
            report(`索引 ${n + 1}/${documents.length} · ${document.name} · 片段 ${i + 1}/${parts.length}`);
            chunks.push({ documentId: document.id, ...parts[i], vector: await embed(profile.passagePrefix + parts[i].text) });
          }
        }
        if (chunks.length > LIMITS.chunks) throw new Error('片段数量超出上限。');
      }
      reply({ id: request.id, type: 'result', result: {
        version: 1, revision: crypto.randomUUID(), fingerprint: fp, profile,
        documents, chunks, updatedAt: new Date().toISOString(),
      } });
    }
  } catch (error) {
    reply({ id: request.id, type: 'error', message: error instanceof Error ? error.message : '本地模型处理失败。' });
  } finally { busy = false; }
};
