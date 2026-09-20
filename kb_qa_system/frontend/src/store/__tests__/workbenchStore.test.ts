import { webcrypto } from "node:crypto";
import { TextEncoder, TextDecoder } from "node:util";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { useWorkbenchStore as store, VAULT_STORAGE_KEY, ACCOUNT_MODEL_ID } from "../workbenchStore";
import { useAuthStore } from "../authStore";
import { completeModel, completeAccountModel, getAccountModel } from "@/services/workbenchModel";
import type { ModelProfile } from "@/types/workbench";
import type { SearchHit } from '@/localKnowledge/core';

vi.mock("@/services/workbenchModel", async (original) => ({ ...await original<typeof import("@/services/workbenchModel")>(), completeModel: vi.fn(), completeAccountModel: vi.fn(), getAccountModel: vi.fn() }));
const profile: Omit<ModelProfile, "hasKey"> = { id: "p1", name: "local", mode: "local", baseUrl: "http://127.0.0.1:11434/v1", model: "test", maxTokens: 100 };
const password = "test-passphrase-1234";
beforeEach(async () => {
  vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("TextEncoder", TextEncoder); vi.stubGlobal("TextDecoder", TextDecoder);
  localStorage.clear(); vi.mocked(completeModel).mockReset();
  vi.mocked(completeAccountModel).mockReset(); vi.mocked(getAccountModel).mockReset();
  useAuthStore.setState({ user: null, isAuthenticated: false });
  store.setState({ accountModel: null });
  await store.getState().unlock(password); await store.getState().saveProfile(profile, "fixture-key");
});
afterEach(async () => { await store.getState().lock(); vi.useRealTimers(); vi.unstubAllGlobals(); });

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
  expect(completeAccountModel).toHaveBeenCalledWith([{ role: "user", content: "hello" }], expect.any(AbortSignal));
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
  expect(completeModel).toHaveBeenCalledWith(expect.objectContaining({ id: profile.id }), 'fixture-key', expect.any(Array), expect.any(AbortSignal));
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
