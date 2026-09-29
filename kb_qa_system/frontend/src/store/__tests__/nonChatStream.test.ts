import { webcrypto } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
import { TextDecoder, TextEncoder } from 'node:util';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { useWorkbenchStore as store, ACCOUNT_MODEL_ID, VAULT_STORAGE_KEY } from '../workbenchStore';
import { useAuthStore } from '../authStore';
import { createAnswerArtifact } from '@/localKnowledge/answerArtifact';
import { importVaultBackup } from '@/services/vaultBackup';
import { documentExportContent } from '@/officeTasks/document';
import { PrivateVault } from '@/services/privateVault';

const source = { documentId: 'synthetic', name: '资料.md', start: 0, end: 4, text: '测试资料', vector: [1], score: 1 };
const input = { title: '测试文档', instruction: '生成测试文档' }, password = 'stream-test-1234';
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('TextEncoder', TextEncoder); vi.stubGlobal('TextDecoder', TextDecoder); vi.stubGlobal('Blob', NodeBlob);
  localStorage.clear(); await store.getState().unlock(password);
  await store.getState().saveProfile({ id: 'local', name: 'local', mode: 'local', model: 'fixture-model', baseUrl: 'http://localhost:11434/v1' }, 'fixture-key');
});
afterEach(async () => { vi.restoreAllMocks(); await store.getState().lock(); useAuthStore.setState({ user: null, isAuthenticated: false }); vi.unstubAllGlobals(); });
function wire() {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({ start: c => { stream = c; }, cancel }), { headers: { 'content-type': 'text/event-stream' } });
  const fetch = vi.fn().mockResolvedValue(response); vi.stubGlobal('fetch', fetch);
  return { fetch, cancel, send: (data: unknown) => stream.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(data) + '\n\n')), end: () => stream.close() };
}
const chunk = (content: string) => ({ choices: [{ index: 0, delta: { content } }] });
const done = (finish_reason: string) => ({ choices: [{ index: 0, delta: {}, finish_reason }] });
function start(kind: 'document' | 'knowledge', preview = vi.fn(), signal = new AbortController().signal, id = 'local') {
  return kind === 'document' ? store.getState().startDocumentTask(id, input, id !== 'local') : store.getState().answerKnowledge(id, '问题', [source], id !== 'local', signal, preview);
}

it.each(['document', 'knowledge'] as const)('shows a transient %s preview, records output limits and roundtrips new metadata in backups', async kind => {
  const connection = wire(), preview = vi.fn(), pending = start(kind, preview);
  await vi.waitFor(() => expect(connection.fetch).toHaveBeenCalled());
  expect(JSON.parse(connection.fetch.mock.calls[0][1].body)).toMatchObject({ stream: true });
  expect(JSON.parse(connection.fetch.mock.calls[0][1].body)).not.toHaveProperty('max_tokens');
  connection.send(chunk('# 增量🌏'));
  await vi.waitFor(() => kind === 'document' ? expect(Object.values(store.getState().generationPreviews)[0]?.text).toBe('# 增量🌏') : expect(preview).toHaveBeenCalledWith({ text: '# 增量🌏', characters: 6 }));
  expect(store.getState().artifacts).toHaveLength(0); expect(store.getState().conversations).toHaveLength(0);
  const disk = await new PrivateVault(localStorage, VAULT_STORAGE_KEY).unlock(password);
  expect(disk.artifacts).toEqual([]); expect(JSON.stringify(disk)).not.toContain('增量');
  connection.send(done('length')); const result = await pending;
  expect(connection.cancel).toHaveBeenCalled();
  if (kind === 'document') {
    expect(store.getState().artifacts[0]).toMatchObject({ finishReason: 'length', content: '# 增量🌏\n' });
    expect(store.getState().toolRuns[0].finishReason).toBe('length');
    expect(documentExportContent(store.getState().artifacts[0])).toContain('回答可能不完整');
    const first = store.getState().artifacts[0]; const edited = await store.getState().saveArtifactVersion(first.id, '# 手动补全');
    expect(store.getState().artifacts.find(a => a.id === edited)?.finishReason).toBeUndefined();
    const restored = await store.getState().restoreArtifactVersion(first.id, edited);
    expect(store.getState().artifacts.find(a => a.id === restored)?.finishReason).toBe('length');
  } else {
    if (typeof result === 'string') throw new Error('Expected answer');
    expect(result).toMatchObject({ content: '# 增量🌏', finishReason: 'length' }); expect(preview).toHaveBeenLastCalledWith(null);
    await store.getState().saveKnowledgeAnswer(createAnswerArtifact('问题', result, [source]));
    expect(store.getState().conversations[0].messages[0]).toMatchObject({ finishReason: 'length' });
    expect(store.getState().conversations[0].messages[0].content).toContain('回答可能不完整');
  }
  const backup = await store.getState().exportWorkbenchBackup('1234', false);
  const restored = (await importVaultBackup(backup.file, '1234')).data;
  expect(restored.artifacts).toEqual(store.getState().artifacts); expect(restored.conversations).toEqual(store.getState().conversations);
  expect(restored.toolRuns).toEqual(store.getState().toolRuns);
  await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().generationPreviews).toEqual({}); expect(connection.fetch).toHaveBeenCalledTimes(1);
});

it.each(['document', 'knowledge'] as const)('rejects a truncated %s stream, discards its preview, and creates no success artifact', async kind => {
  const connection = wire(), preview = vi.fn(), pending = start(kind, preview), rejection = expect(pending).rejects.toThrow('中断');
  await vi.waitFor(() => expect(connection.fetch).toHaveBeenCalled()); connection.send(chunk('截断正文')); connection.end(); await rejection;
  expect(store.getState().artifacts).toHaveLength(0); expect(store.getState().conversations).toHaveLength(0); expect(store.getState().generationPreviews).toEqual({});
  if (kind === 'document') expect(store.getState().taskRuns[0].status).toBe('failed'); else expect(preview).toHaveBeenLastCalledWith(null);
});

it.each([['document', 'stop'], ['knowledge', 'stop'], ['document', 'lock'], ['knowledge', 'lock']] as const)('closes a stalled %s transport on %s and never repopulates memory', async (kind, action) => {
  const connection = wire(), preview = vi.fn(), controller = new AbortController();
  const pending = start(kind, preview, controller.signal), rejection = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(connection.fetch).toHaveBeenCalled()); connection.send(chunk('临时内容'));
  await vi.waitFor(() => kind === 'document' ? expect(Object.keys(store.getState().generationPreviews)).toHaveLength(1) : expect(preview).toHaveBeenCalled());
  if (action === 'lock') await store.getState().lock();
  else if (kind === 'document') store.getState().cancelTask(store.getState().taskRuns[0].id); else controller.abort();
  await rejection; expect(connection.cancel).toHaveBeenCalled();
  expect(store.getState().generationPreviews).toEqual({}); expect(store.getState().artifacts).toHaveLength(0);
  await store.getState().lock(); await store.getState().unlock(password); expect(store.getState().generationPreviews).toEqual({});
});

it.each(['relay', 'account'] as const)('uses the strict %s route for non-chat generation and requires a matching done event', async mode => {
  useAuthStore.setState({ isAuthenticated: true, user: { id: 42, username: 'test', email: 'test@example.test', is_active: true, is_superuser: false, user_type: 'regular', created_at: '' } });
  localStorage.setItem('kb_auth_tokens', JSON.stringify({ access_token: 'synthetic-token', refresh_token: 'synthetic-refresh' }));
  store.setState({ accountModel: { userId: 42, model: 'server' } });
  if (mode === 'relay') await store.getState().saveProfile({ id: 'relay', name: 'relay', mode: 'relay', baseUrl: 'https://model.example/v1', model: 'fixture' }, 'fixture-key');
  const connection = wire(), pending = start('document', vi.fn(), undefined, mode === 'relay' ? 'relay' : ACCOUNT_MODEL_ID);
  const rejection = expect(pending).rejects.toThrow('中断');
  await vi.waitFor(() => expect(connection.fetch).toHaveBeenCalled());
  expect(connection.fetch.mock.calls[0][0]).toContain(mode === 'relay' ? '/private-models/complete/stream' : '/private-models/account/complete/stream');
  connection.send({ type: 'chunk', content: '正文' }); connection.send({ type: 'done', content: 'different', finish_reason: 'stop', model: 'server' }); await rejection;
  expect(store.getState().artifacts).toHaveLength(0); expect(connection.fetch).toHaveBeenCalledTimes(1);
});
