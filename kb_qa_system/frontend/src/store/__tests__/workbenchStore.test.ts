import { webcrypto } from "node:crypto";
import { TextEncoder, TextDecoder } from "node:util";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { useWorkbenchStore as store, VAULT_STORAGE_KEY, ACCOUNT_MODEL_ID } from "../workbenchStore";
import { useAuthStore } from "../authStore";
import { completeModel, completeAccountModel, getAccountModel } from "@/services/workbenchModel";
import { discoverModels } from '@/services/modelDiscovery';
import { completeToolModel, probeToolCallModel } from '@/services/officeToolModel';
import type { ModelProfile } from "@/types/workbench";
import type { SearchHit } from '@/localKnowledge/core';
import { createAnswerArtifact } from '@/localKnowledge/answerArtifact';
import { documentExportContent } from '@/officeTasks/document';
import { exportDocx } from '@/officeTasks/docxClient';
import { checkChart, renderChartSvg, type ChartInput } from '@/officeTasks/chart';
import { validateVaultBackup } from '@/services/vaultBackupSchema';
import { newWorkflow, newWorkflowNode } from '@/workflows/definition';

vi.mock('@/officeTasks/docxClient', () => ({ exportDocx: vi.fn() }));
vi.mock('@/services/modelDiscovery', () => ({ discoverModels: vi.fn() }));
vi.mock('@/services/officeToolModel', () => ({ completeToolModel: vi.fn(), probeToolCallModel: vi.fn() }));

vi.mock("@/services/workbenchModel", async (original) => ({ ...await original<typeof import("@/services/workbenchModel")>(), completeModel: vi.fn(), completeAccountModel: vi.fn(), getAccountModel: vi.fn() }));
const profile: Omit<ModelProfile, "hasKey"> = { id: "p1", name: "local", mode: "local", baseUrl: "http://127.0.0.1:11434/v1", model: "test", maxTokens: 100 };
const password = "test-passphrase-1234";
beforeEach(async () => {
  vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("TextEncoder", TextEncoder); vi.stubGlobal("TextDecoder", TextDecoder);
  localStorage.clear(); vi.mocked(completeModel).mockReset();
  vi.mocked(exportDocx).mockReset();
  vi.mocked(discoverModels).mockReset();
  vi.mocked(completeToolModel).mockReset();
  vi.mocked(probeToolCallModel).mockReset();
  vi.mocked(completeAccountModel).mockReset(); vi.mocked(getAccountModel).mockReset();
  useAuthStore.setState({ user: null, isAuthenticated: false });
  store.setState({ accountModel: null });
  await store.getState().unlock(password); await store.getState().saveProfile(profile, "fixture-key");
});
afterEach(async () => { await store.getState().lock(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('flushes an encrypted workflow draft on lock and restores it without making it runnable', async () => {
  const draft = { ...newWorkflow(), nodes: [newWorkflowNode('create_document', 0)] };
  expect(store.getState().stageWorkflowDraft(draft)).toBe(true);
  expect(store.getState().workflows).toEqual([]);
  await store.getState().lock();
  const encrypted = localStorage.getItem(VAULT_STORAGE_KEY)!;
  expect(encrypted).not.toContain(draft.nodes[0].text);
  await store.getState().unlock(password);
  expect(store.getState().workflowDraft).toMatchObject({ id: draft.id, revision: 0, nodes: draft.nodes });
  expect(store.getState().workflows).toEqual([]);
  await expect(store.getState().startWorkflow(draft.id, 0, { reference: '', csv: '' }, '', false)).rejects.toThrow('未保存');
  const saved = await store.getState().saveWorkflow(store.getState().workflowDraft!);
  expect(saved.revision).toBe(1);
  expect(store.getState().workflowDraft).toBeNull();
});

it('persists a reported output limit alongside text through vault reload', async () => {
  vi.mocked(completeModel).mockImplementation(async (_profile, _key, _messages, _signal, onChunk, onFinish) => {
    onChunk?.('partial'); onFinish?.('length'); return 'partial';
  });
  const id = store.getState().newConversation(); await store.getState().send(id, 'question');
  expect(store.getState().conversations[0].messages.at(-1)).toMatchObject({ content: 'partial', finishReason: 'length' });
  await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().conversations[0].messages.at(-1)).toMatchObject({ content: 'partial', finishReason: 'length' });
});

it("routes concurrent replies back to their own conversations", async () => {
  const pending = new Map<string, (value: string) => void>();
  vi.mocked(completeModel).mockImplementation((_p, _key, messages) => new Promise((resolve) => pending.set(messages[0].content, resolve)));
  const a = store.getState().newConversation(); const runA = store.getState().send(a, "task A");
  const b = store.getState().newConversation(); const runB = store.getState().send(b, "task B");
  await vi.waitFor(() => expect(pending.size).toBe(2));
  pending.get("task B")!("answer B"); await runB; pending.get("task A")!("answer A"); await runA;
  expect(store.getState().currentId).toBe(b);
  expect(store.getState().conversations.find((c) => c.id === a)?.messages.map((m) => m.content)).toEqual(["task A", "answer A"]);
  expect(store.getState().conversations.find((c) => c.id === b)?.messages.map((m) => m.content)).toEqual(["task B", "answer B"]);
  expect(JSON.stringify(store.getState())).not.toContain("fixture-key");
  expect(localStorage.getItem(VAULT_STORAGE_KEY)).not.toContain("fixture-key");
});

it("ignores late responses after locking and recovers the saved user message", async () => {
  let reply!: (value: string) => void;
  vi.mocked(completeModel).mockImplementation(() => new Promise((resolve) => { reply = resolve; }));
  const id = store.getState().newConversation(); const request = store.getState().send(id, "task");
  await vi.waitFor(() => expect(reply).toBeDefined());
  await store.getState().lock(); reply("late answer"); await request;
  expect(store.getState().conversations).toEqual([]);
  await store.getState().unlock(password);
  expect(store.getState().conversations[0].messages.map((m) => m.content)).toEqual(["task"]);
});

it('does not repopulate streaming text after locking, unlocking and starting a replacement request', async () => {
  const pending: { chunk: (value: string) => void; finish: (value: string) => void }[] = [];
  vi.mocked(completeModel).mockImplementation((_p, _key, _messages, _signal, onChunk) => new Promise(resolve => pending.push({ chunk: onChunk!, finish: resolve })));
  const id = store.getState().newConversation();
  const oldRun = store.getState().send(id, 'old');
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  pending[0].chunk('visible-before-lock');
  expect(store.getState().streamingContent[id]).toBe('visible-before-lock');
  await store.getState().lock(); pending[0].chunk('locked-late');
  expect(store.getState().streamingContent).toEqual({});
  await store.getState().unlock(password);
  const newRun = store.getState().send(id, 'new');
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  pending[1].chunk('new-text'); pending[0].chunk('old-late'); pending[0].finish('old-final'); await oldRun;
  expect(store.getState().streamingContent[id]).toBe('new-text');
  expect(store.getState().running[id]).toBe(true);
  pending[1].finish('new-final'); await newRun;
  expect(store.getState().conversations[0].messages.filter(message => message.role === 'assistant').map(message => message.content)).toEqual(['new-final']);
});

it('drops streamed private-cloud text on logout without saving a partial answer', async () => {
  login();
  await store.getState().saveProfile({ ...profile, mode: 'relay', baseUrl: 'https://models.example/v1' }, 'new-fixture-key');
  let chunk!: (value: string) => void, finish!: (value: string) => void;
  vi.mocked(completeModel).mockImplementation((_p, _key, _messages, _signal, onChunk) => new Promise(resolve => { chunk = onChunk!; finish = resolve; }));
  const id = store.getState().newConversation(), running = store.getState().send(id, 'cloud');
  await vi.waitFor(() => expect(finish).toBeDefined());
  chunk('first');
  useAuthStore.setState({ isAuthenticated: false, user: null });
  expect(vi.mocked(completeModel).mock.calls[0][3].aborted).toBe(true);
  chunk('late'); expect(store.getState().streamingContent[id]).toBe('first');
  finish('partial'); await running;
  expect(store.getState().streamingContent[id]).toBeUndefined();
  expect(store.getState().conversations[0].messages).toHaveLength(1);
});

it('cancels a stalled streaming request at the conversation timeout and saves no assistant message', async () => {
  vi.useFakeTimers();
  let streamSignal!: AbortSignal;
  vi.mocked(completeModel).mockImplementation((_p, _key, _messages, signal, onChunk) => new Promise((_resolve, reject) => {
    streamSignal = signal; onChunk?.('partial');
    signal.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')), { once: true });
  }));
  const id = store.getState().newConversation(), running = store.getState().send(id, 'wait');
  await vi.waitFor(() => expect(streamSignal).toBeDefined());
  await vi.advanceTimersByTimeAsync(120_000); await running;
  expect(streamSignal.aborted).toBe(true);
  expect(store.getState().errors[id]).toContain('超时');
  expect(store.getState().running[id]).toBe(false);
  expect(store.getState().streamingContent[id]).toBeUndefined();
  expect(store.getState().conversations[0].messages).toHaveLength(1);
});

it("keeps profile changes and conversation updates during overlapping saves", async () => {
  const first = store.getState().saveProfile({ ...profile, id: "p2" }, "second-key");
  const second = store.getState().saveProfile({ ...profile, id: "p3" }, "third-key");
  const id = store.getState().newConversation(); store.getState().rename(id, "latest title");
  await Promise.all([first, second]); await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().profiles).toHaveLength(3);
  expect(store.getState().conversations[0].title).toBe("latest title");
});

it("does not move an existing key to an edited endpoint without reentry", async () => {
  await expect(store.getState().saveProfile({ ...profile, baseUrl: "http://localhost:1234/v1" }, "")).rejects.toThrow();
  expect(store.getState().profiles[0].baseUrl).toBe(profile.baseUrl);
});

it('discovers with a saved key without persisting catalogs or exposing secrets in public state', async () => {
  vi.mocked(discoverModels).mockResolvedValue({ models: [{ id: 'catalog-only' }], truncated: false });
  const before = localStorage.getItem(VAULT_STORAGE_KEY);
  const result = await store.getState().discoverProfileModels(profile, '', false, new AbortController().signal);
  expect(result.models[0].id).toBe('catalog-only');
  expect(discoverModels).toHaveBeenCalledWith(expect.objectContaining({ id: profile.id }), 'fixture-key', expect.any(AbortSignal));
  expect(JSON.stringify(store.getState())).not.toMatch(/fixture-key|catalog-only/);
  expect(localStorage.getItem(VAULT_STORAGE_KEY)).toBe(before);
});

it('does not send a saved key to an edited discovery endpoint, but permits reentry or clearing', async () => {
  const input = { ...profile, baseUrl: 'http://localhost:1234/v1', model: '', name: '' };
  await expect(store.getState().discoverProfileModels(input, '', false, new AbortController().signal)).rejects.toThrow('重新填写');
  expect(discoverModels).not.toHaveBeenCalled();
  vi.mocked(discoverModels).mockResolvedValue({ models: [], truncated: false });
  await store.getState().discoverProfileModels(input, 'new-fixture-key', false, new AbortController().signal);
  expect(discoverModels).toHaveBeenLastCalledWith(expect.any(Object), 'new-fixture-key', expect.any(AbortSignal));
  await store.getState().discoverProfileModels(input, '', true, new AbortController().signal);
  expect(discoverModels).toHaveBeenLastCalledWith(expect.any(Object), '', expect.any(AbortSignal));
});

it.each(['lock', 'cancel', 'logout'] as const)('aborts discovery on %s and rejects late catalogs', async reason => {
  login();
  let finish!: (value: { models: { id: string }[]; truncated: boolean }) => void;
  vi.mocked(discoverModels).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController();
  const input = reason === 'logout' ? { ...profile, id: 'new-relay', mode: 'relay' as const, baseUrl: 'https://models.example/v1' } : profile;
  const pending = store.getState().discoverProfileModels(input, 'fixture-key', false, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  if (reason === 'lock') await store.getState().lock();
  else if (reason === 'cancel') controller.abort();
  else useAuthStore.setState({ isAuthenticated: false, user: null });
  expect(vi.mocked(discoverModels).mock.calls[0][2].aborted).toBe(true);
  finish({ models: [{ id: 'late' }], truncated: false }); await rejected;
});

it('never reports a successful connection test after vault locking', async () => {
  let finish!: (value: string) => void;
  vi.mocked(completeModel).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = store.getState().testProfile(profile.id);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await store.getState().lock(); finish('late'); await rejected;
});

it('encrypts the successful text-test time and clears it when connection settings change', async () => {
  vi.mocked(completeModel).mockResolvedValue('fixture reply');
  await store.getState().testProfile(profile.id);
  const testedAt = store.getState().profiles[0].textTestedAt;
  expect(testedAt).toBeTruthy();
  expect(store.getState().profiles[0].capabilities?.text).toMatchObject({ state: 'supported', testedAt });
  expect(store.getState().profiles[0].capabilities?.text?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(localStorage.getItem(VAULT_STORAGE_KEY)).not.toContain(testedAt!);
  await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().profiles[0].textTestedAt).toBe(testedAt);
  expect(store.getState().profiles[0].capabilities?.text).toMatchObject({ state: 'supported', testedAt });
  await store.getState().saveProfile({ ...profile, name: 'renamed' }, '');
  expect(store.getState().profiles[0].textTestedAt).toBe(testedAt);
  await store.getState().saveProfile({ ...profile, model: 'changed-model' }, '');
  expect(store.getState().profiles[0].textTestedAt).toBeUndefined();
  expect(store.getState().profiles[0].capabilities).toBeUndefined();
});

it('encrypts tool-call capability only after the inert probe and clears it after a config change', async () => {
  vi.mocked(probeToolCallModel).mockResolvedValue(undefined);
  await store.getState().testProfileToolSupport(profile.id);
  const testedAt = store.getState().profiles[0].toolTestedAt;
  expect(testedAt).toBeTruthy(); expect(probeToolCallModel).toHaveBeenCalledWith(expect.objectContaining({ id: profile.id }), 'fixture-key', expect.any(AbortSignal));
  expect(store.getState().profiles[0].capabilities?.toolCalls).toMatchObject({ state: 'supported', testedAt });
  expect(store.getState().profiles[0].capabilities?.toolCalls?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(localStorage.getItem(VAULT_STORAGE_KEY)).not.toContain(testedAt!);
  await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().profiles[0].toolTestedAt).toBe(testedAt);
  expect(store.getState().profiles[0].capabilities?.toolCalls).toMatchObject({ state: 'supported', testedAt });
  await store.getState().saveProfile({ ...profile, model: 'changed-model' }, '');
  expect(store.getState().profiles[0].toolTestedAt).toBeUndefined();
  expect(store.getState().profiles[0].capabilities).toBeUndefined();
});

it('discards a late tool capability result after the vault is locked', async () => {
  let finish!: () => void;
  vi.mocked(probeToolCallModel).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController(), pending = store.getState().testProfileToolSupport(profile.id, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(finish).toBeDefined());
  await store.getState().lock(); finish(); await rejected;
  expect(store.getState().profiles).toEqual([]);
  await store.getState().unlock(password);
  expect(store.getState().profiles[0].toolTestedAt).toBeUndefined();
});

it('does not attach a late text-test result to a changed profile', async () => {
  let finish!: (value: string) => void;
  vi.mocked(completeModel).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = store.getState().testProfile(profile.id);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(finish).toBeDefined());
  await store.getState().saveProfile({ ...profile, model: 'replacement-model' }, '');
  finish('late response');
  await rejected;
  expect(store.getState().profiles[0].textTestedAt).toBeUndefined();
});

it('rolls back the in-memory success marker when encrypted persistence fails', async () => {
  vi.mocked(completeModel).mockResolvedValue('fixture reply');
  vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => { throw new DOMException('quota exceeded'); });
  await expect(store.getState().testProfile(profile.id)).rejects.toThrow('本机保存失败');
  expect(store.getState().profiles[0].textTestedAt).toBeUndefined();
  await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().profiles[0].textTestedAt).toBeUndefined();
});

it("locks on inactivity even with no workbench component mounted", async () => {
  vi.useFakeTimers(); window.dispatchEvent(new Event("keydown"));
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  expect(store.getState().unlocked).toBe(false);
});

function login() {
  useAuthStore.setState({ isAuthenticated: true, user: { id: 42, username: "test", email: "test@example.com", is_active: true, is_superuser: false, user_type: "regular", created_at: "" } });
}

it("uses the authorized account model when no personal connection exists", async () => {
  await store.getState().removeProfile(profile.id); login();
  vi.mocked(getAccountModel).mockResolvedValue({ model: "server-model" });
  vi.mocked(completeAccountModel).mockResolvedValue({ content: "cloud reply", model: "actual-server-model" });
  await store.getState().refreshAccountModel();
  const id = store.getState().newConversation();
  expect(store.getState().conversations[0].profileId).toBe(ACCOUNT_MODEL_ID);
  await store.getState().send(id, "hello");
  expect(completeModel).not.toHaveBeenCalled();
  expect(completeAccountModel).toHaveBeenCalledWith([{ role: "user", content: "hello" }], expect.any(AbortSignal), expect.any(Function), expect.any(Function));
  expect(store.getState().conversations[0].messages[1]).toMatchObject({ content: "cloud reply", model: "actual-server-model" });
});

it("blocks unauthorized accounts before dispatch and does not silently switch a missing personal profile", async () => {
  await store.getState().removeProfile(profile.id); login();
  vi.mocked(getAccountModel).mockResolvedValue(null); await store.getState().refreshAccountModel();
  const id = store.getState().newConversation();
  await expect(store.getState().send(id, "hello")).rejects.toThrow();
  expect(completeAccountModel).not.toHaveBeenCalled();
  store.setState({ accountModel: { userId: 42, model: "server-model" } });
  store.getState().setProfile(id, "deleted-personal-profile");
  await expect(store.getState().send(id, "hello")).rejects.toThrow();
  expect(completeAccountModel).not.toHaveBeenCalled();
});

it("clears account availability and ignores late cloud replies on logout", async () => {
  await store.getState().removeProfile(profile.id); login();
  store.setState({ accountModel: { userId: 42, model: "server-model" } });
  let reply!: (value: { content: string; model: string }) => void;
  vi.mocked(completeAccountModel).mockImplementation(() => new Promise((resolve) => { reply = resolve; }));
  const id = store.getState().newConversation(); const sending = store.getState().send(id, "hello");
  await vi.waitFor(() => expect(reply).toBeDefined());
  useAuthStore.setState({ user: null, isAuthenticated: false });
  reply({ content: "late cloud reply", model: "server-model" }); await sending;
  expect(store.getState().accountModel).toBeNull();
  expect(store.getState().conversations[0].messages).toHaveLength(1);
});

const source: SearchHit = { documentId: 'fixture', name: 'policy.txt', start: 0, end: 4, text: '测试资料', vector: [1], score: 1 };
it('requires explicit consent for cloud knowledge answers and never falls back', async () => {
  const cloud = { ...profile, id: 'cloud', mode: 'relay' as const, baseUrl: 'https://provider.example/v1' };
  await store.getState().saveProfile(cloud, 'test-only-key');
  await expect(store.getState().answerKnowledge('cloud', '问题', [source], false, new AbortController().signal)).rejects.toThrow('授权');
  expect(completeModel).not.toHaveBeenCalled();
  vi.mocked(completeModel).mockRejectedValue(new Error('provider unavailable'));
  await expect(store.getState().answerKnowledge('cloud', '问题', [source], true, new AbortController().signal)).rejects.toThrow('provider unavailable');
  expect(completeAccountModel).not.toHaveBeenCalled();
  expect(store.getState().conversations).toHaveLength(0);
});
it('can use local models without cloud consent and keeps answer transient', async () => {
  vi.mocked(completeModel).mockResolvedValue('测试回答 [1]');
  const result = await store.getState().answerKnowledge(profile.id, '问题', [source], false, new AbortController().signal);
  expect(result.content).toBe('测试回答 [1]');
  expect(store.getState().conversations).toHaveLength(0);
  expect(completeModel).toHaveBeenCalledWith(expect.objectContaining({ id: profile.id }), 'fixture-key', expect.any(Array), expect.any(AbortSignal), expect.any(Function), expect.any(Function));
});
it('blocks account answers without permission even with consent', async () => {
  await expect(store.getState().answerKnowledge(ACCOUNT_MODEL_ID, '问题', [source], true, new AbortController().signal)).rejects.toThrow('没有可用');
  expect(completeAccountModel).not.toHaveBeenCalled();
});
it('aborts knowledge requests on vault lock and ignores late replies', async () => {
  let finish!: (value: string) => void;
  vi.mocked(completeModel).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const result = store.getState().answerKnowledge(profile.id, '问题', [source], false, new AbortController().signal);
  const rejected = expect(result).rejects.toThrow('取消');
  await vi.waitFor(() => expect(finish).toBeDefined());
  await store.getState().lock(); finish('late answer'); await rejected;
});

it('encrypts one read-only source archive across repeated saves and unlocks without any model request', async () => {
  const answer = createAnswerArtifact('private question', { content: 'private answer [1]', model: 'fixture model' }, [source]);
  const ids = await Promise.all([store.getState().saveKnowledgeAnswer(answer), store.getState().saveKnowledgeAnswer(answer)]);
  expect(ids[0]).toBe(ids[1]);
  expect(store.getState().conversations).toHaveLength(1);
  expect(localStorage.getItem(VAULT_STORAGE_KEY)).not.toMatch(/private question|private answer|测试资料/);
  await store.getState().lock(); await store.getState().unlock(password);
  const saved = store.getState().conversations[0];
  expect(saved.kind).toBe('knowledge-answer');
  expect(saved.messages[0].content).toContain('测试资料');
  store.getState().setProfile(saved.id, profile.id);
  expect(store.getState().conversations[0].profileId).toBe('');
  await expect(store.getState().send(saved.id, 'continue')).rejects.toThrow('只读');
  expect(completeModel).not.toHaveBeenCalled(); expect(completeAccountModel).not.toHaveBeenCalled();
});

it('reports quota failure and retries the same in-memory archive without duplicating it', async () => {
  const answer = createAnswerArtifact('question', { content: 'answer', model: 'model' }, [source]);
  const spy = vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => { throw new DOMException('quota', 'QuotaExceededError'); });
  await expect(store.getState().saveKnowledgeAnswer(answer)).rejects.toThrow('保存失败');
  expect(store.getState().storageError).toBeTruthy();
  spy.mockRestore();
  await store.getState().saveKnowledgeAnswer(answer);
  expect(store.getState().storageError).toBeNull();
  await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().conversations).toHaveLength(1);
});

it('does not report save success or repopulate memory when locking during encryption', async () => {
  const answer = createAnswerArtifact('question', { content: 'answer', model: 'model' }, [source]);
  const pending = store.getState().saveKnowledgeAnswer(answer);
  const rejected = expect(pending).rejects.toThrow('锁定');
  await store.getState().lock(); await rejected;
  expect(store.getState().conversations).toEqual([]);
  await expect(store.getState().saveKnowledgeAnswer(answer)).rejects.toThrow('解锁');
});

const documentInput = { title: '项目周报', instruction: '整理进展、风险和下周计划', sourceName: 'notes.txt', sourceContent: '已完成登录模块，等待安全评审。' };
it('persists document TaskRun, ToolRun and Artifact encrypted and restores them without another request', async () => {
  vi.mocked(completeModel).mockResolvedValue('```markdown\n# 项目周报\n\n## 进展\n\n已完成登录模块。\n```');
  const id = await store.getState().startDocumentTask(profile.id, documentInput, false);
  const task = store.getState().taskRuns.find(item => item.id === id)!;
  const tool = store.getState().toolRuns.find(item => item.taskId === id)!;
  const artifact = store.getState().artifacts.find(item => item.taskId === id)!;
  expect(task).toMatchObject({ status: 'succeeded', artifactIds: [artifact.id], toolRunIds: [tool.id] });
  expect(tool).toMatchObject({ status: 'succeeded', model: 'test' });
  expect(artifact.content).toBe('# 项目周报\n\n## 进展\n\n已完成登录模块。\n');
  expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(localStorage.getItem(VAULT_STORAGE_KEY)).not.toMatch(/项目周报|登录模块|fixture-key/);
  expect(completeModel).toHaveBeenCalledWith(expect.objectContaining({ id: profile.id }), 'fixture-key', expect.arrayContaining([
    expect.objectContaining({ role: 'system' }), expect.objectContaining({ role: 'user' }),
  ]), expect.any(AbortSignal), expect.any(Function), expect.any(Function));
  await store.getState().lock(); vi.mocked(completeModel).mockClear(); await store.getState().unlock(password);
  expect(store.getState().taskRuns[0].status).toBe('succeeded');
  expect(store.getState().artifacts[0].content).toContain('已完成登录模块');
  expect(completeModel).not.toHaveBeenCalled();
});

it('requires per-request cloud consent before creating a document task', async () => {
  const cloud = { ...profile, id: 'cloud-task', mode: 'relay' as const, baseUrl: 'https://provider.example/v1' };
  await store.getState().saveProfile(cloud, 'cloud-fixture-key');
  await expect(store.getState().startDocumentTask(cloud.id, documentInput, false)).rejects.toThrow('授权');
  expect(store.getState().taskRuns).toHaveLength(0); expect(completeModel).not.toHaveBeenCalled();
  vi.mocked(completeModel).mockResolvedValue('# 文档');
  await store.getState().startDocumentTask(cloud.id, documentInput, true);
  expect(store.getState().taskRuns[0].status).toBe('succeeded');
  expect(completeAccountModel).not.toHaveBeenCalled();
});

it('records an explicit cancellation and keeps no partial artifact', async () => {
  let finish!: (value: string) => void;
  vi.mocked(completeModel).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = store.getState().startDocumentTask(profile.id, documentInput, false);
  await vi.waitFor(() => { expect(store.getState().taskRuns[0]?.status).toBe('running'); expect(finish).toBeTypeOf('function'); });
  const id = store.getState().taskRuns[0].id; store.getState().cancelTask(id); finish('# late');
  await expect(pending).rejects.toThrow('取消');
  expect(store.getState().taskRuns[0]).toMatchObject({ status: 'cancelled', artifactIds: [] });
  expect(store.getState().toolRuns[0].status).toBe('cancelled'); expect(store.getState().artifacts).toEqual([]);
});

it('marks a persisted running task interrupted after vault lock and unlock', async () => {
  let finish!: (value: string) => void;
  vi.mocked(completeModel).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = store.getState().startDocumentTask(profile.id, documentInput, false);
  await vi.waitFor(() => { expect(store.getState().taskRuns[0]?.status).toBe('running'); expect(finish).toBeTypeOf('function'); });
  await store.getState().lock(); finish('# late'); await expect(pending).rejects.toThrow('取消');
  await store.getState().unlock(password);
  expect(store.getState().taskRuns[0]).toMatchObject({ status: 'interrupted', artifactIds: [] });
  expect(store.getState().toolRuns[0].status).toBe('interrupted'); expect(store.getState().artifacts).toEqual([]);
});

it('deletes a completed task with its tools and artifacts, but not a running task', async () => {
  vi.mocked(completeModel).mockResolvedValue('# done');
  const id = await store.getState().startDocumentTask(profile.id, documentInput, false);
  await store.getState().removeTask(id);
  expect(store.getState().taskRuns).toEqual([]); expect(store.getState().toolRuns).toEqual([]); expect(store.getState().artifacts).toEqual([]);
  let finish!: (value: string) => void;
  vi.mocked(completeModel).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = store.getState().startDocumentTask(profile.id, documentInput, false);
  await vi.waitFor(() => { expect(store.getState().taskRuns[0]?.status).toBe('running'); expect(finish).toBeTypeOf('function'); });
  await expect(store.getState().removeTask(store.getState().taskRuns[0].id)).rejects.toThrow('取消');
  store.getState().cancelTask(store.getState().taskRuns[0].id); finish('# late'); await expect(pending).rejects.toThrow();
});

it('does not call a model when the initial encrypted task record cannot be saved', async () => {
  const spy = vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => { throw new DOMException('quota', 'QuotaExceededError'); });
  await expect(store.getState().startDocumentTask(profile.id, documentInput, false)).rejects.toThrow('保存失败');
  expect(completeModel).not.toHaveBeenCalled();
  expect(store.getState().taskRuns[0]).toMatchObject({ status: 'failed', error: '任务记录未能保存，模型尚未调用。' });
  expect(store.getState().artifacts).toEqual([]);
  spy.mockRestore();
});

it('reserves the shared three-request limit before asynchronous task persistence', async () => {
  vi.mocked(completeModel).mockResolvedValue('# done');
  const runs = [0, 1, 2].map(index => store.getState().startDocumentTask(profile.id, { ...documentInput, title: `task ${index}` }, false));
  await expect(store.getState().startDocumentTask(profile.id, { ...documentInput, title: 'task 4' }, false)).rejects.toThrow('最多同时');
  await Promise.all(runs);
  expect(completeModel).toHaveBeenCalledTimes(3);
  expect(store.getState().taskRuns.every(task => task.status === 'succeeded')).toBe(true);
});

it('cancels during initial persistence without dispatching a model request', async () => {
  const pending = store.getState().startDocumentTask(profile.id, documentInput, false);
  store.getState().cancelTask(store.getState().taskRuns[0].id);
  await expect(pending).rejects.toThrow('取消');
  expect(completeModel).not.toHaveBeenCalled();
  expect(store.getState().taskRuns[0].status).toBe('cancelled');
});

it('does not dispatch or restore memory if locked during initial task persistence', async () => {
  const pending = store.getState().startDocumentTask(profile.id, documentInput, false);
  const rejected = expect(pending).rejects.toThrow('锁定');
  await store.getState().lock(); await rejected;
  expect(completeModel).not.toHaveBeenCalled(); expect(store.getState().taskRuns).toEqual([]);
  await store.getState().unlock(password);
  expect(store.getState().taskRuns[0].status).toBe('interrupted');
});

async function documentArtifact() {
  vi.mocked(completeModel).mockResolvedValue('# 原始文档\n');
  await store.getState().startDocumentTask(profile.id, documentInput, false);
  vi.mocked(completeModel).mockClear();
  return store.getState().artifacts[0];
}

it('keeps immutable parent versions, exact edits and their tool provenance across unlock', async () => {
  const original = await documentArtifact(), edited = '```md\n原样保留围栏\n```\n\n';
  const id = await store.getState().saveArtifactVersion(original.id, edited);
  expect(store.getState().artifacts[0]).toEqual(original);
  expect(store.getState().artifacts[1]).toMatchObject({ id, parentArtifactId: original.id, version: 2, content: edited });
  expect(store.getState().toolRuns[1]).toMatchObject({ tool: 'document.edit', sourceArtifactId: original.id, outputArtifactId: id });
  await expect(store.getState().saveArtifactVersion(original.id, 'stale edit')).rejects.toThrow('更新版本');
  expect(await store.getState().saveArtifactVersion(id, edited)).toBe(id);
  expect(localStorage.getItem(VAULT_STORAGE_KEY)).not.toContain('原样保留');
  await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().artifacts).toHaveLength(2); expect(store.getState().artifacts[1].content).toBe(edited);
  expect(completeModel).not.toHaveBeenCalled();
});

it('reserves revision work before hashing and rejects concurrent edits and removal', async () => {
  const original = await documentArtifact();
  const pending = store.getState().saveArtifactVersion(original.id, '# changed');
  await expect(store.getState().saveArtifactVersion(original.id, '# another')).rejects.toThrow('正在保存');
  await expect(store.getState().removeTask(original.taskId)).rejects.toThrow('正在保存');
  await pending; expect(store.getState().artifacts).toHaveLength(2);
});

it('retains a failed-save revision for download and retries without duplicating history', async () => {
  const original = await documentArtifact();
  const spy = vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => { throw new DOMException('quota', 'QuotaExceededError'); });
  await expect(store.getState().saveArtifactVersion(original.id, '# edited')).rejects.toThrow('保存失败');
  expect(store.getState().storageError).toBeTruthy(); expect(store.getState().artifacts).toHaveLength(2);
  spy.mockRestore(); await store.getState().saveArtifactVersion(original.id, '# edited');
  expect(store.getState().artifacts).toHaveLength(2); expect(store.getState().storageError).toBeNull();
  await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().artifacts).toHaveLength(2);
});

it('does not insert an edited version after a lock during hashing', async () => {
  const original = await documentArtifact();
  const pending = store.getState().saveArtifactVersion(original.id, '# edited');
  const rejected = expect(pending).rejects.toThrow('锁定');
  await store.getState().lock(); await rejected;
  expect(store.getState().artifacts).toEqual([]);
  await store.getState().unlock(password); expect(store.getState().artifacts).toHaveLength(1);
});

it('exports the selected old version and stores only provenance and a hash, never binary', async () => {
  const original = await documentArtifact();
  await store.getState().saveArtifactVersion(original.id, '# new version');
  const bytes = new TextEncoder().encode('synthetic docx bytes').buffer;
  vi.mocked(exportDocx).mockResolvedValue({ bytes, warnings: ['test warning'], converterVersion: 'fixture/1' });
  const result = await store.getState().exportArtifactDocx(original.id);
  expect(result).toMatchObject({ bytes, name: expect.stringMatching(/-v1\.docx$/), warnings: ['test warning'] });
  expect(exportDocx).toHaveBeenCalledWith(documentExportContent(original), documentInput.title, expect.any(AbortSignal), 'standard');
  expect(store.getState().toolRuns.at(-1)).toMatchObject({ tool: 'document.export-docx', status: 'succeeded', sourceArtifactId: original.id, outputSha256: expect.stringMatching(/^[a-f0-9]{64}$/), converterVersion: 'fixture/1' });
  expect(JSON.stringify(store.getState())).not.toContain('synthetic docx bytes');
  await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().artifacts).toHaveLength(2); expect(store.getState().toolRuns.at(-1)?.status).toBe('succeeded');
  expect(completeModel).not.toHaveBeenCalled();
});

it('records the selected DOCX style with the export provenance', async () => {
  const original = await documentArtifact();
  const bytes = new TextEncoder().encode('business docx').buffer;
  vi.mocked(exportDocx).mockResolvedValue({ bytes, warnings: [], converterVersion: 'markdown-docx/2:business' });
  await store.getState().exportArtifactDocx(original.id, 'business');
  expect(exportDocx).toHaveBeenCalledWith(documentExportContent(original), documentInput.title, expect.any(AbortSignal), 'business');
  expect(store.getState().toolRuns.at(-1)).toMatchObject({
    arguments: JSON.stringify({ style: 'business' }), converterVersion: 'markdown-docx/2:business',
  });
});

it('fails export before conversion on initial persistence failure and leaves the document intact', async () => {
  const original = await documentArtifact();
  const spy = vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => { throw new DOMException('quota', 'QuotaExceededError'); });
  await expect(store.getState().exportArtifactDocx(original.id)).rejects.toThrow('保存失败');
  spy.mockRestore(); expect(exportDocx).not.toHaveBeenCalled();
  expect(store.getState().taskRuns[0].status).toBe('succeeded'); expect(store.getState().artifacts[0]).toEqual(original);
  expect(store.getState().toolRuns.at(-1)?.status).toBe('failed');
});

it('aborts an export on lock and repairs only its running tool on unlock', async () => {
  const original = await documentArtifact();
  let finish!: (value: Awaited<ReturnType<typeof exportDocx>>) => void;
  vi.mocked(exportDocx).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = store.getState().exportArtifactDocx(original.id);
  const rejected = expect(pending).rejects.toThrow('锁定');
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  await store.getState().lock();
  expect(vi.mocked(exportDocx).mock.calls[0][2].aborted).toBe(true);
  finish({ bytes: new ArrayBuffer(0), warnings: [], converterVersion: 'test' }); await rejected;
  expect(store.getState().artifacts).toEqual([]);
  await store.getState().unlock(password);
  expect(store.getState().toolRuns.at(-1)?.status).toBe('interrupted');
  expect(store.getState().taskRuns[0].status).toBe('succeeded');
});

it('restores old content as a new head with both parent and recovery source, encrypted across unlock', async () => {
  const original = await documentArtifact();
  const secondId = await store.getState().saveArtifactVersion(original.id, '# revised\r\n\n');
  const second = store.getState().artifacts[1];
  const thirdId = await store.getState().restoreArtifactVersion(original.id, secondId);
  expect(store.getState().artifacts.slice(0, 2)).toEqual([original, second]);
  expect(store.getState().artifacts[2]).toMatchObject({ id: thirdId, version: 3, parentArtifactId: secondId, restoredFromArtifactId: original.id, content: original.content, sha256: original.sha256 });
  expect(store.getState().toolRuns.at(-1)).toMatchObject({ tool: 'document.restore', sourceArtifactId: original.id, previousArtifactId: secondId, outputArtifactId: thirdId });
  expect(localStorage.getItem(VAULT_STORAGE_KEY)).not.toContain('原始文档');
  await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().artifacts[2].restoredFromArtifactId).toBe(original.id);
  expect(store.getState().taskRuns[0].artifactIds).toEqual([original.id, secondId, thirdId]);
  expect(completeModel).not.toHaveBeenCalled(); expect(completeAccountModel).not.toHaveBeenCalled();
  const fourthId = await store.getState().saveArtifactVersion(thirdId, '# edited after restore');
  expect(store.getState().artifacts.at(-1)).toMatchObject({ id: fourthId, parentArtifactId: thirdId, version: 4 });
  expect(store.getState().artifacts.at(-1)?.restoredFromArtifactId).toBeUndefined();
});

it('rejects stale recovery confirmation, missing sources and another task head', async () => {
  const original = await documentArtifact();
  const second = await store.getState().saveArtifactVersion(original.id, '# two');
  const third = await store.getState().saveArtifactVersion(second, '# three');
  await expect(store.getState().restoreArtifactVersion(original.id, second)).rejects.toThrow('更新版本');
  await expect(store.getState().restoreArtifactVersion('missing', third)).rejects.toThrow('源成果');
  vi.mocked(completeModel).mockResolvedValue('# unrelated');
  const otherTask = await store.getState().startDocumentTask(profile.id, { ...documentInput, title: 'other task' }, false);
  const other = store.getState().artifacts.find(item => item.taskId === otherTask)!;
  await expect(store.getState().restoreArtifactVersion(other.id, third)).rejects.toThrow('更新版本');
  expect(store.getState().artifacts).toHaveLength(4);
});

it('retries failed recovery persistence without duplicate versions and treats identical content as no-op', async () => {
  const original = await documentArtifact();
  const second = await store.getState().saveArtifactVersion(original.id, '# two');
  const spy = vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => { throw new DOMException('quota', 'QuotaExceededError'); });
  await expect(store.getState().restoreArtifactVersion(original.id, second)).rejects.toThrow('保存失败');
  spy.mockRestore();
  const third = store.getState().artifacts[2].id;
  expect(await store.getState().restoreArtifactVersion(original.id, second)).toBe(third);
  expect(await store.getState().restoreArtifactVersion(original.id, third)).toBe(third);
  expect(store.getState().artifacts).toHaveLength(3); expect(store.getState().toolRuns).toHaveLength(3);
  await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().artifacts.at(-1)?.id).toBe(third);
});

it('uses the shared lock for restore, edit, export and delete and drops late recovery on vault lock', async () => {
  const original = await documentArtifact();
  const second = await store.getState().saveArtifactVersion(original.id, '# two');
  const pending = store.getState().restoreArtifactVersion(original.id, second);
  const rejected = expect(pending).rejects.toThrow('锁定');
  const conflicts = [store.getState().saveArtifactVersion(second, '# concurrent'), store.getState().exportArtifactDocx(second), store.getState().removeTask(original.taskId)];
  await store.getState().lock();
  for (const conflict of conflicts) await expect(conflict).rejects.toThrow('正在保存');
  await rejected;
  expect(store.getState().artifacts).toEqual([]);
  await store.getState().unlock(password); expect(store.getState().artifacts).toHaveLength(2);
});

it('rejects recovery at the version limit without changing history', async () => {
  const original = await documentArtifact();
  const versions = Array.from({ length: 50 }, (_, index) => ({ ...original, id: `version-${index}`, version: index + 1, content: `# ${index}` }));
  store.setState({ artifacts: versions, taskRuns: [{ ...store.getState().taskRuns[0], artifactIds: versions.map(item => item.id) }] });
  await expect(store.getState().restoreArtifactVersion(versions[0].id, versions[49].id)).rejects.toThrow('50 个版本');
  expect(store.getState().artifacts).toHaveLength(50);
});

it('holds the task lock while retrying an already-created recovery snapshot', async () => {
  const original = await documentArtifact();
  const second = await store.getState().saveArtifactVersion(original.id, '# two');
  const third = await store.getState().restoreArtifactVersion(original.id, second);
  const retry = store.getState().restoreArtifactVersion(original.id, second);
  await expect(store.getState().saveArtifactVersion(third, '# racing edit')).rejects.toThrow('正在保存');
  expect(await retry).toBe(third);
});

const chartInput: ChartInput = { title: '本地销售图', csv: '月份,销售额\n一月,120\n二月,-40', categoryColumn: 0, valueColumn: 1, chartType: 'bar', unit: '元' };
it('persists chart input, two tool runs, warnings and a hashed SVG without any model request', async () => {
  const requestId = crypto.randomUUID();
  const id = await store.getState().startChartTask(chartInput, requestId);
  expect(store.getState().taskRuns[0]).toMatchObject({ id, type: 'chart.generate', chartInput, status: 'succeeded', profileId: '' });
  expect(store.getState().toolRuns.map(tool => tool.tool)).toEqual(['chart.check', 'chart.render']);
  expect(store.getState().toolRuns[0].warnings?.join(' ')).toContain('负值');
  const svg = store.getState().artifacts[0];
  expect(svg).toMatchObject({ kind: 'svg', mimeType: 'image/svg+xml', sha256: expect.stringMatching(/^[a-f0-9]{64}$/), content: renderChartSvg(checkChart(chartInput)) });
  expect(store.getState().toolRuns[1].outputArtifactId).toBe(svg.id);
  expect(localStorage.getItem(VAULT_STORAGE_KEY)).not.toMatch(/本地销售图|一月|<svg/);
  await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().artifacts[0]).toEqual(svg);
  expect(await store.getState().startChartTask(chartInput, requestId)).toBe(id);
  expect(store.getState().taskRuns).toHaveLength(1);
  expect(completeModel).not.toHaveBeenCalled(); expect(completeAccountModel).not.toHaveBeenCalled();
});
it('blocks invalid data and request reuse with changed chart inputs', async () => {
  await expect(store.getState().startChartTask({ ...chartInput, csv: 'a,b\nx,' }, crypto.randomUUID())).rejects.toThrow('数值');
  expect(store.getState().taskRuns).toHaveLength(0);
  const id = crypto.randomUUID(); await store.getState().startChartTask(chartInput, id);
  await expect(store.getState().startChartTask({ ...chartInput, title: 'changed' }, id)).rejects.toThrow('内容已改变');
  const artifact = store.getState().artifacts[0];
  await expect(store.getState().saveArtifactVersion(artifact.id, '# incorrect')).rejects.toThrow('仅 Markdown');
  await expect(store.getState().restoreArtifactVersion(artifact.id, artifact.id)).rejects.toThrow('仅 Markdown');
  await expect(store.getState().exportArtifactDocx(artifact.id)).rejects.toThrow('仅 Markdown');
  await store.getState().removeTask(artifact.taskId);
  expect(store.getState().taskRuns).toEqual([]); expect(store.getState().artifacts).toEqual([]); expect(store.getState().toolRuns).toEqual([]);
});
it('snapshots multi-series selection before async work and restores the same encrypted chart', async () => {
  const valueColumns = [2, 1];
  const multi = { ...chartInput, csv: '月份,收入,成本\n一月,100,30\n二月,200,-40', valueColumn: 2, valueColumns };
  const requestId = crypto.randomUUID();
  const pending = store.getState().startChartTask(multi, requestId);
  valueColumns.reverse();
  const id = await pending;
  const task = store.getState().taskRuns.find(item => item.id === id)!;
  expect(task.chartInput?.valueColumns).toEqual([2, 1]);
  const svg = store.getState().artifacts[0];
  expect(svg.content).toContain('成本 · 二月: -40');
  expect(localStorage.getItem(VAULT_STORAGE_KEY)).not.toMatch(/成本|一月|<svg/);
  expect(store.getState().toolRuns.find(tool => tool.tool === 'chart.render')?.converterVersion).toBe('local-chart/3');
  await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().taskRuns[0].chartInput?.valueColumns).toEqual([2, 1]);
  expect(store.getState().artifacts[0]).toEqual(svg);
  await expect(store.getState().startChartTask(multi, requestId)).rejects.toThrow('内容已改变');
  expect(completeModel).not.toHaveBeenCalled(); expect(completeAccountModel).not.toHaveBeenCalled();
});
it('does not render an artifact when initial encrypted chart persistence fails', async () => {
  const spy = vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => { throw new DOMException('quota', 'QuotaExceededError'); });
  await expect(store.getState().startChartTask(chartInput, crypto.randomUUID())).rejects.toThrow('保存失败');
  spy.mockRestore(); expect(store.getState().artifacts).toEqual([]); expect(store.getState().taskRuns[0].status).toBe('failed');
});
it('keeps final-save-failed chart output and retries the same request without duplicate artifacts', async () => {
  const id = crypto.randomUUID(), originalWrite = localStorage.setItem.bind(localStorage); let writes = 0;
  const spy = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => { if (++writes === 2) throw new DOMException('quota', 'QuotaExceededError'); originalWrite(key, value); });
  await expect(store.getState().startChartTask(chartInput, id)).rejects.toThrow('保存失败');
  expect(store.getState().storageError).toBeTruthy(); expect(store.getState().artifacts).toHaveLength(1);
  spy.mockRestore(); await store.getState().startChartTask(chartInput, id);
  expect(store.getState().storageError).toBeNull(); expect(store.getState().artifacts).toHaveLength(1); expect(store.getState().toolRuns).toHaveLength(2);
  await store.getState().lock(); await store.getState().unlock(password); expect(store.getState().artifacts).toHaveLength(1);
});
it('rejects duplicate in-flight chart tasks and cancels loading on lock', async () => {
  const id = crypto.randomUUID();
  const pending = store.getState().startChartTask(chartInput, id);
  const rejected = expect(pending).rejects.toThrow('锁定');
  await expect(store.getState().startChartTask(chartInput, id)).rejects.toThrow('正在处理');
  await store.getState().lock(); await rejected; expect(store.getState().artifacts).toEqual([]);
});

const officeInput = { title: '工具报告', instruction: '写报告', sourceContent: '仅限本次任务的参考材料' };
const documentToolReply = { content: null, tool_calls: [{ id: 'doc-call', type: 'function' as const, function: { name: 'create_document' as const, arguments: JSON.stringify({ title: '结果', markdown: '# 结果\n\n正文。' }) } }] };
it('keeps independent document version chains even when tool outputs have identical names', async () => {
  vi.mocked(completeToolModel).mockResolvedValueOnce({ ...documentToolReply, tool_calls: [
    documentToolReply.tool_calls[0], { ...documentToolReply.tool_calls[0], id: 'second-document', function: { name: 'create_document', arguments: JSON.stringify({ title: '结果', markdown: '# 第二份文档' }) } },
  ] }).mockResolvedValueOnce({ content: '已完成。', tool_calls: [] });
  const taskId = await store.getState().startOfficeToolTask(profile.id, officeInput, false);
  const [a, b] = store.getState().artifacts;
  expect(a.name).toBe(b.name);
  const editedA = await store.getState().saveArtifactVersion(a.id, '# 第一份修改');
  const editedB = await store.getState().saveArtifactVersion(b.id, '# 第二份修改');
  expect(store.getState().artifacts.find(item => item.id === editedA)).toMatchObject({ version: 2, parentArtifactId: a.id });
  expect(store.getState().artifacts.find(item => item.id === editedB)).toMatchObject({ version: 2, parentArtifactId: b.id });
  await expect(store.getState().restoreArtifactVersion(a.id, editedB)).rejects.toThrow('更新版本');
  const restoredA = await store.getState().restoreArtifactVersion(a.id, editedA);
  expect(store.getState().artifacts.find(item => item.id === restoredA)).toMatchObject({ version: 3, parentArtifactId: editedA, restoredFromArtifactId: a.id, content: a.content });
  const checkpoint = store.getState().toolRuns.find(tool => tool.tool === 'office.create_document' && tool.outputArtifactId === a.id)!;
  expect(checkpoint.outputSha256).toBe(a.sha256);
  const data = { profiles: [], conversations: [], taskRuns: store.getState().taskRuns, toolRuns: store.getState().toolRuns, artifacts: store.getState().artifacts };
  await expect(validateVaultBackup(data)).resolves.toMatchObject({ artifacts: expect.arrayContaining([expect.objectContaining({ id: restoredA })]) });
  const invalid = structuredClone(data); invalid.artifacts.find(item => item.id === restoredA)!.restoredFromArtifactId = b.id;
  await expect(validateVaultBackup(invalid)).rejects.toThrow('备份内容无效');
  await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().artifacts).toHaveLength(5); expect(completeToolModel).toHaveBeenCalledTimes(2);
  await store.getState().removeTask(taskId); expect(store.getState().artifacts).toEqual([]);
});
it('edits preserved partial documents without replaying failed tool tasks and retries persistence only', async () => {
  vi.mocked(completeToolModel).mockResolvedValueOnce(documentToolReply).mockRejectedValueOnce(new Error('offline'));
  await expect(store.getState().startOfficeToolTask(profile.id, officeInput, false)).rejects.toThrow('offline');
  const source = store.getState().artifacts[0];
  const write = vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => { throw new DOMException('quota', 'QuotaExceededError'); });
  await expect(store.getState().saveArtifactVersion(source.id, '# 修订')).rejects.toThrow('保存失败');
  write.mockRestore(); const id = await store.getState().saveArtifactVersion(source.id, '# 修订');
  expect(store.getState().artifacts).toHaveLength(2); expect(store.getState().taskRuns[0].status).toBe('failed');
  expect(store.getState().artifacts.find(a => a.id === id)?.version).toBe(2); expect(completeToolModel).toHaveBeenCalledTimes(2);
  store.setState({ taskRuns: store.getState().taskRuns.map(task => ({ ...task, status: 'running' })) });
  await expect(store.getState().saveArtifactVersion(id, '# running edit')).rejects.toThrow('任务尚未完成');
});
it('persists multi-step artifacts and tool records encrypted, then restores without rerunning the model', async () => {
  vi.mocked(completeToolModel).mockResolvedValueOnce(documentToolReply).mockResolvedValueOnce({ content: '已完成。', tool_calls: [] });
  const id = await store.getState().startOfficeToolTask(profile.id, officeInput, false);
  expect(store.getState().taskRuns.find(task => task.id === id)).toMatchObject({ type: 'office.tools', status: 'succeeded', summary: '已完成。' });
  expect(store.getState().toolRuns.filter(tool => tool.taskId === id)).toHaveLength(3);
  expect(localStorage.getItem(VAULT_STORAGE_KEY)).not.toMatch(/参考材料|正文|fixture-key/);
  expect(completeToolModel).toHaveBeenCalledTimes(2);
  await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().artifacts.find(artifact => artifact.taskId === id)?.content).toContain('正文');
  expect(completeToolModel).toHaveBeenCalledTimes(2);
});

it('stops after failed checkpoint persistence and preserves the artifact without rerunning tools', async () => {
  vi.mocked(completeToolModel).mockResolvedValueOnce(documentToolReply).mockResolvedValueOnce({ content: '已完成。', tool_calls: [] });
  const original = localStorage.setItem.bind(localStorage);
  const spy = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (store.getState().artifacts.length) throw new DOMException('quota', 'QuotaExceededError');
    original(key, value);
  });
  await expect(store.getState().startOfficeToolTask(profile.id, officeInput, false)).rejects.toThrow('保存失败');
  expect(store.getState().artifacts).toHaveLength(1);
  expect(store.getState().taskRuns[0].status).toBe('failed');
  expect(completeToolModel).toHaveBeenCalledTimes(1);
  spy.mockRestore(); await store.getState().retryStorage();
  await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().artifacts).toHaveLength(1);
  expect(completeToolModel).toHaveBeenCalledTimes(1);
});

it('blocks multi-round cloud traffic until consent and cancels it on account change', async () => {
  login();
  await store.getState().saveProfile({ ...profile, mode: 'relay', baseUrl: 'https://models.example/v1' }, 'new-fixture-key');
  await expect(store.getState().startOfficeToolTask(profile.id, officeInput, false)).rejects.toThrow('明确授权');
  expect(completeToolModel).not.toHaveBeenCalled();
  let finish!: (value: typeof documentToolReply) => void;
  vi.mocked(completeToolModel).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = store.getState().startOfficeToolTask(profile.id, officeInput, true);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(finish).toBeDefined());
  useAuthStore.setState({ user: null, isAuthenticated: false });
  expect(vi.mocked(completeToolModel).mock.calls[0][3].aborted).toBe(true);
  finish(documentToolReply); await rejected;
  expect(store.getState().artifacts).toHaveLength(0);
  expect(store.getState().taskRuns[0].status).toBe('cancelled');
});

it('keeps completed tool outputs but marks an interrupted task on vault lock, with no automatic resume', async () => {
  let finish!: (value: { content: string; tool_calls: [] }) => void;
  vi.mocked(completeToolModel).mockResolvedValueOnce(documentToolReply).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = store.getState().startOfficeToolTask(profile.id, officeInput, false);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(finish).toBeDefined());
  await store.getState().lock(); finish({ content: 'late', tool_calls: [] }); await rejected;
  expect(store.getState().taskRuns).toHaveLength(0);
  await store.getState().unlock(password);
  expect(store.getState().taskRuns[0].status).toBe('interrupted'); expect(store.getState().artifacts).toHaveLength(1);
  expect(completeToolModel).toHaveBeenCalledTimes(2);
});
