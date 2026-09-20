import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalEmbeddingClient } from './client';
import { DEFAULT_PROFILE } from './core';
import type { Reply } from './protocol';
class FakeWorker {
  static last: FakeWorker;
  onmessage: ((event: { data: Reply }) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage = vi.fn(); terminate = vi.fn();
  constructor() { FakeWorker.last = this; }
}
afterEach(() => vi.unstubAllGlobals());
describe('opt-in worker lifecycle', () => {
  it('does not construct a worker merely by importing the client', () => {
    const worker = vi.fn(); vi.stubGlobal('Worker', worker);
    expect(worker).not.toHaveBeenCalled();
  });
  it('rejects pending work on cancel and ignores stale completion', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const client = new LocalEmbeddingClient(vi.fn());
    const result = client.init(DEFAULT_PROFILE);
    const caught = expect(result).rejects.toThrow('取消');
    client.stop(); await caught;
    FakeWorker.last.onmessage?.({ data: { id: 1, type: 'result', result: null } });
    expect(FakeWorker.last.terminate).toHaveBeenCalledOnce();
    await expect(client.query('hello')).rejects.toThrow('已停止');
  });
  it('serializes work and exposes errors from the worker', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const client = new LocalEmbeddingClient(vi.fn());
    const result = client.init(DEFAULT_PROFILE);
    await expect(client.query('hello')).rejects.toThrow('等待');
    FakeWorker.last.onmessage?.({ data: { id: 1, type: 'error', message: '维度错误' } });
    await expect(result).rejects.toThrow('维度错误'); client.stop();
  });
});
