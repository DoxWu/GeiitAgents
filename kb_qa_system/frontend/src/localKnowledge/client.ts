import type { EmbeddingProfile, LocalDocument, LocalIndex } from './core';
import type { Reply, Request } from './protocol';

// Constructed only by an explicit enable action. Importing this module creates no Worker.
export class LocalEmbeddingClient {
  private worker: Worker;
  private counter = 0;
  private pending: { id: number; resolve: (value: Reply & { type: 'result' }) => void; reject: (error: Error) => void } | null = null;
  private closed = false;
  constructor(private progress: (message: string) => void) {
    this.worker = new Worker(new URL('./embedding.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<Reply>) => {
      const value = event.data;
      if (value.id !== this.pending?.id) return;
      if (value.type === 'progress') this.progress(value.message);
      else {
        const pending = this.pending; this.pending = null;
        if (value.type === 'error') pending.reject(new Error(value.message)); else pending.resolve(value);
      }
    };
    this.worker.onerror = () => this.stop('本地推理运行时加载失败，请检查资源、浏览器或 CSP 配置。');
  }
  private request(request: Request): Promise<Reply & { type: 'result' }> {
    if (this.closed) return Promise.reject(new Error('本地模型已停止，请重新启用。'));
    if (this.pending) return Promise.reject(new Error('请等待当前任务完成。'));
    return new Promise((resolve, reject) => {
      this.pending = { id: request.id, resolve, reject };
      this.worker.postMessage(request);
    });
  }
  async init(profile: EmbeddingProfile) { await this.request({ id: ++this.counter, type: 'init', profile }); }
  async build(documents: LocalDocument[], base: LocalIndex | null) {
    return (await this.request({ id: ++this.counter, type: 'build', documents, base })).result as LocalIndex;
  }
  async query(text: string) {
    return (await this.request({ id: ++this.counter, type: 'query', text })).result as number[];
  }
  stop(message = '操作已取消；原索引保留。') {
    this.closed = true;
    this.worker.terminate();
    this.pending?.reject(new Error(message));
    this.pending = null;
  }
}
