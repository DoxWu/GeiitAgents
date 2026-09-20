import { create } from "zustand";
import { PrivateVault } from "@/services/privateVault";
import { completeModel, completeAccountModel, getAccountModel, validateProfile } from "@/services/workbenchModel";
import { useAuthStore } from "@/store/authStore";
import type { ModelProfile, VaultData, WorkConversation, WorkMessage } from "@/types/workbench";

export const VAULT_STORAGE_KEY = "geiit.workbench.encrypted.v1";
export const ACCOUNT_MODEL_ID = "$account";
let vault: PrivateVault | null = null;
let secrets: VaultData["profiles"] = [];
let generation = 0;
const controllers = new Map<string, AbortController>();
const accountRequests = new Set<string>();
let accountLookup: AbortController | null = null;

interface WorkbenchState {
  unlocked: boolean;
  profiles: ModelProfile[];
  conversations: WorkConversation[];
  currentId: string | null;
  running: Record<string, boolean>;
  errors: Record<string, string>;
  storageError: string | null;
  accountModel: { userId: number; model: string } | null;
  accountLoading: boolean;
  accountError: string | null;
  refreshAccountModel: () => Promise<void>;
  unlock: (password: string) => Promise<void>;
  lock: () => Promise<void>;
  saveProfile: (input: Omit<ModelProfile, "hasKey">, apiKey: string, clearKey?: boolean) => Promise<void>;
  removeProfile: (id: string) => Promise<void>;
  testProfile: (id: string) => Promise<void>;
  newConversation: (profileId?: string) => string;
  select: (id: string) => void;
  rename: (id: string, title: string) => void;
  removeConversation: (id: string) => void;
  setProfile: (id: string, profileId: string) => void;
  send: (id: string, text: string) => Promise<void>;
  cancel: (id: string) => void;
}

function publicProfiles(): ModelProfile[] {
  return secrets.map(({ apiKey, ...profile }) => ({ ...profile, hasKey: Boolean(apiKey) }));
}

async function persist(required = false) {
  if (!vault || !useWorkbenchStore.getState().unlocked) return;
  const epoch = generation;
  try {
    await vault.save({ profiles: secrets, conversations: useWorkbenchStore.getState().conversations });
    if (epoch === generation) useWorkbenchStore.setState({ storageError: null });
  } catch {
    const message = "本机保存失败。请导出重要对话，并检查存储空间或其他窗口。";
    if (epoch === generation) useWorkbenchStore.setState({ storageError: message });
    if (required) throw new Error(message);
  }
}

function eraseMemory() {
  generation++;
  for (const controller of controllers.values()) controller.abort();
  controllers.clear();
  secrets = [];
  vault?.lock();
  vault = null;
  useWorkbenchStore.setState({ unlocked: false, profiles: [], conversations: [], currentId: null, running: {}, errors: {} });
}

export const useWorkbenchStore = create<WorkbenchState>((set, get) => ({
  unlocked: false, profiles: [], conversations: [], currentId: null, running: {}, errors: {}, storageError: null,
  accountModel: null, accountLoading: false, accountError: null,
  refreshAccountModel: async () => {
    accountLookup?.abort();
    const user = useAuthStore.getState().user;
    if (!useAuthStore.getState().isAuthenticated || !user) {
      set({ accountModel: null, accountLoading: false, accountError: null }); return;
    }
    const controller = new AbortController();
    accountLookup = controller;
    set({ accountModel: null, accountLoading: true, accountError: null });
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const model = await getAccountModel(controller.signal);
      if (accountLookup !== controller || controller.signal.aborted || useAuthStore.getState().user?.id !== user.id) return;
      set({ accountModel: model ? { ...model, userId: user.id } : null });
    } catch {
      if (accountLookup === controller) set({ accountError: "账号云端模型暂不可用。" });
    } finally {
      clearTimeout(timeout);
      if (accountLookup === controller) set({ accountLoading: false });
    }
  },
  unlock: async (password) => {
    const epoch = ++generation;
    const candidate = new PrivateVault(window.localStorage, VAULT_STORAGE_KEY);
    const data = await candidate.unlock(password);
    if (epoch !== generation) { candidate.lock(); return; }
    vault = candidate;
    secrets = data.profiles;
    set({ unlocked: true, profiles: publicProfiles(), conversations: data.conversations,
      currentId: data.conversations[0]?.id ?? null, running: {}, errors: {}, storageError: null });
  },
  lock: async () => {
    const epoch = ++generation;
    const lockingVault = vault;
    for (const controller of controllers.values()) controller.abort();
    set({ unlocked: false, profiles: [], conversations: [], currentId: null, running: {}, errors: {} });
    secrets = [];
    try { await lockingVault?.flush(); } catch { /* Keep the last successfully encrypted snapshot. */ }
    lockingVault?.lock();
    if (epoch === generation) eraseMemory();
  },
  saveProfile: async (input, apiKey, clearKey = false) => {
    if (!get().unlocked || !vault) throw new Error("请先解锁本机密钥库。");
    const baseUrl = validateProfile(input);
    const previous = secrets.find((profile) => profile.id === input.id);
    if (secrets.length >= 30 && !previous) throw new Error("最多保存 30 个模型连接。");
    const secret = clearKey ? "" : apiKey.trim() || previous?.apiKey || "";
    if (secret.length > 4096 || /[^\x21-\x7e]/.test(secret)) throw new Error("API Key 格式无效。");
    if (input.mode === "relay" && !secret) throw new Error("云端模型需要 API Key。");
    // A saved key must not silently follow an edited endpoint to another provider.
    if (previous?.apiKey && previous.baseUrl !== baseUrl && !apiKey.trim() && !clearKey) {
      throw new Error("接口地址已改变，请重新填写 API Key 或勾选清除密钥。");
    }
    const profile = { ...input, name: input.name.trim(), model: input.model.trim(), baseUrl, apiKey: secret };
    const next = [...secrets.filter((item) => item.id !== input.id), profile];
    secrets = next;
    set({ profiles: publicProfiles() });
    await persist(true);
  },
  removeProfile: async (id) => {
    if (Object.keys(get().running).some((cid) => get().running[cid] && get().conversations.find((c) => c.id === cid)?.profileId === id)) {
      throw new Error("此连接仍有运行中的对话。");
    }
    if (!vault) return;
    const next = secrets.filter((profile) => profile.id !== id);
    secrets = next;
    set({ profiles: publicProfiles() });
    await persist(true);
  },
  testProfile: async (id) => {
    const profile = get().profiles.find((item) => item.id === id);
    const secret = secrets.find((item) => item.id === id);
    if (!profile || !secret) throw new Error("请先保存模型连接。");
    const controller = new AbortController();
    const token = `test:${crypto.randomUUID()}`;
    controllers.set(token, controller);
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try { await completeModel(profile, secret.apiKey, [{ role: "user", content: "Reply OK." }], controller.signal); }
    finally { clearTimeout(timeout); controllers.delete(token); }
  },
  newConversation: (profileId) => {
    if (!get().unlocked) return "";
    const id = crypto.randomUUID();
    const conversation: WorkConversation = { id, title: "新对话", profileId: profileId || get().profiles[0]?.id || (get().accountModel ? ACCOUNT_MODEL_ID : ""), messages: [], updatedAt: new Date().toISOString() };
    set((state) => ({ conversations: [conversation, ...state.conversations], currentId: id }));
    void persist();
    return id;
  },
  select: (id) => { set({ currentId: id }); },
  rename: (id, title) => {
    if (!title.trim()) return;
    set((state) => ({ conversations: state.conversations.map((c) => c.id === id ? { ...c, title: title.trim().slice(0, 100) } : c) }));
    void persist();
  },
  removeConversation: (id) => {
    get().cancel(id);
    const remaining = get().conversations.filter((item) => item.id !== id);
    set({ conversations: remaining, currentId: get().currentId === id ? remaining[0]?.id ?? null : get().currentId });
    void persist();
  },
  setProfile: (id, profileId) => {
    if (get().running[id]) return;
    set((state) => ({ conversations: state.conversations.map((c) => c.id === id ? { ...c, profileId } : c) }));
    void persist();
  },
  send: async (id, text) => {
    if (!get().unlocked || get().running[id] || !text.trim()) return;
    const conversation = get().conversations.find((item) => item.id === id);
    const profile = get().profiles.find((item) => item.id === conversation?.profileId);
    const secret = secrets.find((item) => item.id === profile?.id);
    const useAccount = conversation?.profileId === ACCOUNT_MODEL_ID || (!conversation?.profileId && !get().profiles.length);
    if (!conversation) throw new Error("请先新建对话。");
    if (useAccount) {
      if (!get().accountModel || !useAuthStore.getState().isAuthenticated || get().accountModel?.userId !== useAuthStore.getState().user?.id) throw new Error("当前账号没有可用的云端模型，请登录有权限的账号或添加模型连接。");
    } else if (!profile || !secret) throw new Error("请先选择已保存的模型连接。");
    if (Object.values(get().running).filter(Boolean).length >= 3) throw new Error("最多同时运行 3 个对话。");
    if (text.length > 100000 || conversation.messages.length >= 98 || conversation.messages.reduce((n, m) => n + m.content.length, text.length) > 200000) {
      throw new Error("对话内容已达上限，请新建对话或缩短材料。");
    }
    const userMessage: WorkMessage = { id: crypto.randomUUID(), role: "user", content: text.trim(), createdAt: new Date().toISOString() };
    const messages = [...conversation.messages, userMessage];
    const controller = new AbortController();
    controllers.set(id, controller);
    if (useAccount) accountRequests.add(id);
    const epoch = generation;
    const timeout = setTimeout(() => controller.abort(), 120_000);
    set((state) => ({
      conversations: state.conversations.map((c) => c.id === id ? { ...c, profileId: useAccount ? ACCOUNT_MODEL_ID : c.profileId, messages, title: c.messages.length ? c.title : text.trim().slice(0, 28), updatedAt: userMessage.createdAt } : c),
      running: { ...state.running, [id]: true }, errors: { ...state.errors, [id]: "" },
    }));
    await persist();
    try {
      if (epoch !== generation || controller.signal.aborted) return;
      const input = messages.map(({ role, content }) => ({ role, content }));
      const result = useAccount ? await completeAccountModel(input, controller.signal) : {
        content: await completeModel(profile!, secret!.apiKey, input, controller.signal), model: profile!.model,
      };
      if (epoch !== generation || controller.signal.aborted) return;
      const message: WorkMessage = { id: crypto.randomUUID(), role: "assistant", ...result, createdAt: new Date().toISOString() };
      set((state) => ({ conversations: state.conversations.map((c) => c.id === id ? { ...c, messages: [...c.messages, message], updatedAt: message.createdAt } : c) }));
      await persist();
    } catch (error) {
      if (epoch === generation) set((state) => ({ errors: { ...state.errors, [id]: controller.signal.aborted ? "请求已停止或超时。" : error instanceof Error ? error.message : "模型请求失败。" } }));
    } finally {
      clearTimeout(timeout);
      accountRequests.delete(id);
      if (epoch === generation) {
        controllers.delete(id);
        set((state) => ({ running: { ...state.running, [id]: false } }));
      }
    }
  },
  cancel: (id) => { controllers.get(id)?.abort(); },
}));

window.addEventListener("storage", (event) => {
  if ((!event.key || event.key === VAULT_STORAGE_KEY) && useWorkbenchStore.getState().unlocked) eraseMemory();
});
window.addEventListener("pagehide", eraseMemory);

useAuthStore.subscribe((state, previous) => {
  if (state.user?.id !== previous.user?.id || state.isAuthenticated !== previous.isAuthenticated) {
    accountLookup?.abort(); accountLookup = null;
    for (const id of accountRequests) controllers.get(id)?.abort();
    useWorkbenchStore.setState({ accountModel: null, accountLoading: false, accountError: null });
  }
});

let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
function recordActivity() {
  clearTimeout(inactivityTimer);
  if (useWorkbenchStore.getState().unlocked) {
    inactivityTimer = setTimeout(() => { void useWorkbenchStore.getState().lock(); }, 15 * 60_000);
  }
}
useWorkbenchStore.subscribe((state, previous) => {
  if (state.unlocked !== previous.unlocked) recordActivity();
});
window.addEventListener("pointerdown", recordActivity);
window.addEventListener("keydown", recordActivity);
