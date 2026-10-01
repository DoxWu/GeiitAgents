import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { exportDocx } from './docxClient';

class FakeWorker {
  static latest: FakeWorker;
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { FakeWorker.latest = this; }
}
beforeEach(() => { vi.stubGlobal('Worker', FakeWorker); vi.useFakeTimers(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('terminates the worker after a successful transferable result', async () => {
  const pending = exportDocx('# local', 'title', new AbortController().signal);
  const result = { ok: true, bytes: new ArrayBuffer(3), converterVersion: 'fixture', warnings: [] };
  expect(FakeWorker.latest.postMessage).toHaveBeenCalledWith({ content: '# local', title: 'title', style: 'standard' });
  FakeWorker.latest.onmessage!({ data: result });
  await expect(pending).resolves.toEqual(result);
  expect(FakeWorker.latest.terminate).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});
it('terminates on cancellation and never returns output', async () => {
  const controller = new AbortController();
  const pending = exportDocx('# local', 'title', controller.signal);
  controller.abort(); await expect(pending).rejects.toThrow('取消');
  expect(FakeWorker.latest.terminate).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});
it('bounds expensive parser and compression work to thirty seconds', async () => {
  const pending = exportDocx('# local', 'title', new AbortController().signal);
  const rejected = expect(pending).rejects.toThrow('超时');
  await vi.advanceTimersByTimeAsync(30000); await rejected;
  expect(FakeWorker.latest.terminate).toHaveBeenCalledTimes(1);
});
it('reports a worker load failure and clears the timer', async () => {
  const pending = exportDocx('# local', 'title', new AbortController().signal);
  FakeWorker.latest.onerror!(); await expect(pending).rejects.toThrow('无法启动');
  expect(FakeWorker.latest.terminate).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});
