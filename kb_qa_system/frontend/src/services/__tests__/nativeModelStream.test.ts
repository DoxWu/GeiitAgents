import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { completeModel } from '../workbenchModel';
import type { ModelProfile } from '@/types/workbench';
import type { Channel } from '@tauri-apps/api/core';

const native = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>(),
  channels: [] as Channel<{ content: string }>[],
}));
vi.mock('@/api/client', () => ({ apiClient: {}, getStoredTokens: vi.fn() }));
const profile: ModelProfile = { id: 'local', name: 'Local', mode: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', hasKey: false };
const messages = [{ role: 'user', content: 'hello' }];
beforeEach(() => {
  native.invoke.mockReset(); native.channels.length = 0;
  vi.stubGlobal('__TAURI_INTERNALS__', {
    transformCallback: vi.fn(() => native.channels.length + 100), unregisterCallback: vi.fn(),
    invoke: (command: string, args: Record<string, unknown>) => {
      if (args.onChunk) native.channels.push(args.onChunk as Channel<{ content: string }>);
      return native.invoke(command, args);
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

it('shows native chunks before completion and ignores queued events after final content', async () => {
  let finish!: (value: unknown) => void;
  native.invoke.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const chunks: string[] = [];
  const pending = completeModel(profile, '', messages, new AbortController().signal, chunk => chunks.push(chunk));
  await vi.waitFor(() => expect(finish).toBeDefined());
  expect(native.invoke.mock.calls[0][0]).toBe('stream_local_model');
  const emit = native.channels[0].onmessage;
  emit({ content: '你好' }); expect(chunks).toEqual(['你好']);
  emit({ content: '🌏' }); finish({ content: '你好🌏' });
  await expect(pending).resolves.toBe('你好🌏');
  emit({ content: 'late' }); native.channels[0].onmessage({ content: 'late' });
  expect(chunks).toEqual(['你好', '🌏']);
});

it('keeps the nonstream command for callers that do not request progress', async () => {
  native.invoke.mockResolvedValue({ content: 'whole response' });
  await expect(completeModel(profile, '', messages, new AbortController().signal)).resolves.toBe('whole response');
  expect(native.channels).toHaveLength(0);
  expect(native.invoke).toHaveBeenCalledWith('complete_local_model', expect.not.objectContaining({ onChunk: expect.anything() }));
});

it('uses the native HTTPS provider transport without account authentication', async () => {
  native.invoke.mockResolvedValue({ content: 'provider reply' });
  await expect(completeModel({ ...profile, mode: 'direct', baseUrl: 'https://provider.example/v1', hasKey: true }, 'provider-fixture', messages, new AbortController().signal)).resolves.toBe('provider reply');
  expect(native.invoke).toHaveBeenCalledWith('complete_local_model', expect.objectContaining({ direct: true, baseUrl: 'https://provider.example/v1', apiKey: 'provider-fixture' }));
});

it('isolates channels for concurrent conversations', async () => {
  const finish: ((value: unknown) => void)[] = [], left: string[] = [], right: string[] = [];
  native.invoke.mockImplementation(() => new Promise(resolve => finish.push(resolve)));
  const a = completeModel(profile, '', messages, new AbortController().signal, chunk => left.push(chunk));
  const b = completeModel(profile, '', messages, new AbortController().signal, chunk => right.push(chunk));
  await vi.waitFor(() => expect(finish).toHaveLength(2));
  expect(native.invoke.mock.calls[0][1].requestId).not.toBe(native.invoke.mock.calls[1][1].requestId);
  native.channels[1].onmessage({ content: 'B' }); native.channels[0].onmessage({ content: 'A' });
  finish[1]({ content: 'B' }); finish[0]({ content: 'A' }); await Promise.all([a, b]);
  expect(left).toEqual(['A']); expect(right).toEqual(['B']);
});

it('sends native cancellation and drops queued text while the command finishes', async () => {
  let finish!: (value: unknown) => void;
  native.invoke.mockImplementation(command => command === 'cancel_local_model' ? Promise.resolve(undefined) : new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController(), chunks: string[] = [];
  const pending = completeModel(profile, '', messages, controller.signal, chunk => chunks.push(chunk));
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(finish).toBeDefined());
  native.channels[0].onmessage({ content: 'before' });
  controller.abort(); native.channels[0].onmessage({ content: 'after' });
  finish({ content: 'beforeafter' }); await rejected;
  expect(chunks).toEqual(['before']);
  expect(native.invoke).toHaveBeenCalledWith('cancel_local_model', { requestId: native.invoke.mock.calls[0][1].requestId });
});

it.each([null, { content: '' }, { content: 42 }, { content: 'x'.repeat(1_000_001) }])('rejects invalid final native output', async response => {
  native.invoke.mockResolvedValue(response);
  await expect(completeModel(profile, '', messages, new AbortController().signal)).rejects.toThrow('输出中断');
});

it('does not expose native/provider error details and stops a broken callback safely', async () => {
  native.invoke.mockRejectedValueOnce('upstream fixture-secret');
  await expect(completeModel(profile, '', messages, new AbortController().signal, () => {})).rejects.toThrow('本机模型请求失败或输出中断');
  let finish!: (value: unknown) => void;
  native.invoke.mockImplementation(command => command === 'cancel_local_model' ? Promise.resolve(undefined) : new Promise(resolve => { finish = resolve; }));
  const pending = completeModel(profile, '', messages, new AbortController().signal, () => { throw new Error('fixture-secret'); });
  const rejected = expect(pending).rejects.toThrow('输出中断');
  await vi.waitFor(() => expect(finish).toBeDefined());
  native.channels[1].onmessage({ content: 'text' }); finish({ content: 'text' }); await rejected;
  expect(native.invoke).toHaveBeenCalledWith('cancel_local_model', expect.any(Object));
});
