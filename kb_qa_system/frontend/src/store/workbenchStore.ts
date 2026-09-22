import { create } from "zustand";
import { PrivateVault } from "@/services/privateVault";
import { completeModel, completeAccountModel, getAccountModel, validateProfile } from "@/services/workbenchModel";
import { useAuthStore } from "@/store/authStore";
import type { ModelProfile, TaskRun, ToolRun, VaultData, WorkArtifact, WorkConversation, WorkMessage } from "@/types/workbench";
import type { SearchHit } from '@/localKnowledge/core';
import { buildKnowledgeMessages } from '@/localKnowledge/answer';
import { answerMarkdown, type KnowledgeAnswerArtifact } from '@/localKnowledge/answerArtifact';
import { buildDocumentMessages, normalizeDocumentMarkdown, sha256Text, validateDocumentTask, type DocumentTaskInput } from '@/officeTasks/document';

export const VAULT_STORAGE_KEY = "geiit.workbench.encrypted.v1";
export const ACCOUNT_MODEL_ID = "$account";
let vault: PrivateVault | null = null;
let secrets: VaultData["profiles"] = [];
let generation = 0;
const controllers = new Map<string, AbortController>();
const artifactOperations = new Map<string, AbortController>();
const accountRequests = new Set<string>();
let accountLookup: AbortController | null = null;

interface WorkbenchState {
  unlocked: boolean;
  profiles: ModelProfile[];
  conversations: WorkConversation[];
  taskRuns: TaskRun[];
  toolRuns: ToolRun[];
  artifacts: WorkArtifact[];
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
  saveKnowledgeAnswer: (answer: KnowledgeAnswerArtifact) => Promise<string>;
  startDocumentTask: (profileId: string, input: DocumentTaskInput, allowCloud: boolean) => Promise<string>;
  cancelTask: (id: string) => void;
  removeTask: (id: string) => Promise<void>;
  saveArtifactVersion: (sourceId: string, content: string) => Promise<string>;
  exportArtifactDocx: (sourceId: string) => Promise<{ bytes: ArrayBuffer; name: string; warnings: string[] }>;
  retryStorage: () => Promise<void>;
  answerKnowledge: (profileId: string, question: string, sources: SearchHit[], allowCloud: boolean, signal: AbortSignal) => Promise<{ content: string; model: string }>;
}

function publicProfiles(): ModelProfile[] {
  return secrets.map(({ apiKey, ...profile }) => ({ ...profile, hasKey: Boolean(apiKey) }));
}

async function persist(required = false) {
  if (!vault || !useWorkbenchStore.getState().unlocked) {
    if (required) throw new Error('请先解锁本机密钥库。');
    return;
  }
  const epoch = generation;
  try {
    const state = useWorkbenchStore.getState();
    await vault.save({ profiles: secrets, conversations: state.conversations, taskRuns: state.taskRuns, toolRuns: state.toolRuns, artifacts: state.artifacts });
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
  for (const controller of artifactOperations.values()) controller.abort();
  artifactOperations.clear();
  secrets = [];
  vault?.lock();
  vault = null;
  useWorkbenchStore.setState({ unlocked: false, profiles: [], conversations: [], taskRuns: [], toolRuns: [], artifacts: [], currentId: null, running: {}, errors: {} });
}

export const useWorkbenchStore = create<WorkbenchState>((set, get) => ({
  unlocked: false, profiles: [], conversations: [], taskRuns: [], toolRuns: [], artifacts: [], currentId: null, running: {}, errors: {}, storageError: null,
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
    const unlockedAt = new Date().toISOString();
    const taskRuns = (data.taskRuns ?? []).map(task => task.status === 'running' ? { ...task, status: 'interrupted' as const, updatedAt: unlockedAt,
      error: '客户端在任务完成前关闭或锁定，结果未生成。' } : task);
    const toolRuns = (data.toolRuns ?? []).map(tool => tool.status === 'running' ? { ...tool, status: 'interrupted' as const, finishedAt: unlockedAt,
      error: '客户端在工具调用完成前关闭或锁定。' } : tool);
    set({ unlocked: true, profiles: publicProfiles(), conversations: data.conversations, taskRuns, toolRuns, artifacts: data.artifacts ?? [],
      currentId: data.conversations[0]?.id ?? null, running: {}, errors: {}, storageError: null });
    if (taskRuns.some((task, index) => task !== (data.taskRuns ?? [])[index]) || toolRuns.some((tool, index) => tool !== (data.toolRuns ?? [])[index])) await persist();
  },
  lock: async () => {
    const epoch = ++generation;
    const lockingVault = vault;
    for (const controller of controllers.values()) controller.abort();
    for (const controller of artifactOperations.values()) controller.abort();
    set({ unlocked: false, profiles: [], conversations: [], taskRuns: [], toolRuns: [], artifacts: [], currentId: null, running: {}, errors: {} });
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
    if (get().taskRuns.some(task => task.profileId === id && task.status === 'running')) throw new Error('此连接仍有运行中的文档任务。');
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
    if (get().running[id] || get().conversations.find(c => c.id === id)?.kind === 'knowledge-answer') return;
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
    if (conversation.kind === 'knowledge-answer') throw new Error('来源快照是只读记录，请新建对话。');
    if (useAccount) {
      if (!get().accountModel || !useAuthStore.getState().isAuthenticated || get().accountModel?.userId !== useAuthStore.getState().user?.id) throw new Error("当前账号没有可用的云端模型，请登录有权限的账号或添加模型连接。");
    } else if (!profile || !secret) throw new Error("请先选择已保存的模型连接。");
    if (controllers.size >= 3) throw new Error("最多同时运行 3 个模型请求。");
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
  saveKnowledgeAnswer: async (answer) => {
    if (!get().unlocked || !vault) throw new Error('请先解锁本机密钥库。');
    const epoch = generation;
    const id = `knowledge-answer:${answer.id}`;
    if (!get().conversations.some(c => c.id === id)) {
      const conversation: WorkConversation = { id, kind: 'knowledge-answer', profileId: '',
        title: `知识回答 · ${answer.question.trim().slice(0, 28)}`, updatedAt: answer.createdAt,
        messages: [{ id: answer.id, role: 'assistant', model: answer.model, createdAt: answer.createdAt, content: answerMarkdown(answer) }] };
      set(state => ({ conversations: [conversation, ...state.conversations] }));
    }
    // Retry persists the same record. Keep the in-memory copy on storage failure for export/retry.
    await persist(true);
    if (epoch !== generation || !get().unlocked) throw new Error('密钥库已锁定，请解锁后检查保存记录。');
    set({ currentId: id });
    return id;
  },
  startDocumentTask: async (profileId, input, allowCloud) => {
    if (!get().unlocked || !vault) throw new Error('请先解锁本机密钥库。');
    if (get().taskRuns.length >= 100) throw new Error('最多保留 100 个办公任务，请先删除旧任务。');
    const clean = validateDocumentTask(input);
    const messages = buildDocumentMessages(clean);
    const profile = get().profiles.find(item => item.id === profileId);
    const secret = secrets.find(item => item.id === profileId);
    const account = profileId === ACCOUNT_MODEL_ID;
    if (account) {
      if (!get().accountModel || !useAuthStore.getState().isAuthenticated || get().accountModel?.userId !== useAuthStore.getState().user?.id) throw new Error('当前账号没有可用的云端模型，请先检查账号权限。');
    } else if (!profile || !secret) throw new Error('请选择已保存的生成模型连接。');
    if ((account || profile?.mode === 'relay') && !allowCloud) throw new Error('发送任务要求和参考材料到云端前需要明确授权。');
    if (controllers.size >= 3) throw new Error('最多同时运行 3 个模型请求。');
    const id = crypto.randomUUID(), toolId = crypto.randomUUID(), now = new Date().toISOString();
    const controller = new AbortController(), token = `task:${id}`, epoch = generation;
    controllers.set(token, controller); if (account || profile?.mode === 'relay') accountRequests.add(token);
    const task: TaskRun = { id, type: 'document.generate-markdown', title: clean.title, profileId, instruction: clean.instruction,
      ...(clean.sourceName ? { sourceName: clean.sourceName } : {}), ...(clean.sourceContent ? { sourceContent: clean.sourceContent } : {}),
      status: 'running', createdAt: now, updatedAt: now, toolRunIds: [toolId], artifactIds: [] };
    const tool: ToolRun = { id: toolId, taskId: id, tool: 'model.complete', status: 'running', startedAt: now };
    set(state => ({ taskRuns: [task, ...state.taskRuns], toolRuns: [tool, ...state.toolRuns] }));
    try { await persist(true); }
    catch (error) {
      controllers.delete(token); accountRequests.delete(token);
      const failedAt = new Date().toISOString();
      set(state => ({ taskRuns: state.taskRuns.map(item => item.id === id ? { ...item, status: 'failed', updatedAt: failedAt, error: '任务记录未能保存，模型尚未调用。' } : item),
        toolRuns: state.toolRuns.map(item => item.id === toolId ? { ...item, status: 'failed', finishedAt: failedAt, error: '任务记录未能保存。' } : item) }));
      throw error;
    }
    const timeout = setTimeout(() => controller.abort(), 120000);
    try {
      if (controller.signal.aborted || epoch !== generation || !get().unlocked) throw new DOMException('任务已取消或密钥库已锁定', 'AbortError');
      const result = account ? await completeAccountModel(messages, controller.signal) : {
        content: await completeModel(profile!, secret!.apiKey, messages, controller.signal), model: profile!.model,
      };
      if (controller.signal.aborted || epoch !== generation) throw new DOMException('任务已取消或密钥库已锁定', 'AbortError');
      const content = normalizeDocumentMarkdown(result.content), completedAt = new Date().toISOString();
      const artifact: WorkArtifact = { id: crypto.randomUUID(), taskId: id, kind: 'markdown', version: 1,
        name: `${clean.title.replace(/[<>:"/\\|?*]/g, '_') || 'document'}.md`, mimeType: 'text/markdown', content,
        sha256: await sha256Text(content), createdAt: completedAt };
      if (controller.signal.aborted || epoch !== generation) throw new DOMException('任务已取消或密钥库已锁定', 'AbortError');
      set(state => ({ artifacts: [artifact, ...state.artifacts],
        taskRuns: state.taskRuns.map(item => item.id === id ? { ...item, status: 'succeeded', updatedAt: completedAt, artifactIds: [artifact.id], error: undefined } : item),
        toolRuns: state.toolRuns.map(item => item.id === toolId ? { ...item, status: 'succeeded', model: result.model, finishedAt: completedAt, error: undefined } : item) }));
      await persist(true);
      if (epoch !== generation || !get().unlocked) throw new Error('密钥库已锁定，请解锁后检查任务成果。');
      return id;
    } catch (error) {
      if (epoch === generation && !get().taskRuns.find(item => item.id === id)?.artifactIds.length) {
        const stoppedAt = new Date().toISOString(), cancelled = controller.signal.aborted;
        const message = cancelled ? '任务已取消或超时。' : error instanceof Error ? error.message : '文档生成失败。';
        set(state => ({ taskRuns: state.taskRuns.map(item => item.id === id ? { ...item, status: cancelled ? 'cancelled' : 'failed', updatedAt: stoppedAt, error: message } : item),
          toolRuns: state.toolRuns.map(item => item.id === toolId ? { ...item, status: cancelled ? 'cancelled' : 'failed', finishedAt: stoppedAt, error: message } : item) }));
        await persist();
      }
      throw error;
    } finally {
      clearTimeout(timeout); controllers.delete(token); accountRequests.delete(token);
    }
  },
  cancelTask: (id) => { controllers.get(`task:${id}`)?.abort(); },
  retryStorage: async () => {
    const epoch = generation;
    await persist(true);
    if (epoch !== generation || !get().unlocked) throw new Error('密钥库已锁定。');
  },
  saveArtifactVersion: async (sourceId, content) => {
    if (!get().unlocked || !vault) throw new Error('请先解锁本机密钥库。');
    const source = get().artifacts.find(item => item.id === sourceId);
    const task = get().taskRuns.find(item => item.id === source?.taskId);
    if (!source || !task || task.status !== 'succeeded') throw new Error('源成果不存在或任务尚未完成。');
    if (artifactOperations.has(task.id)) throw new Error('此任务正在保存或导出，请稍后重试。');
    // User edits must be preserved exactly; unlike model output, do not strip a surrounding code fence.
    if (!content.trim() || content.length > 1_000_000 || content.includes('\0')) throw new Error('成果需要非空文本，最多 1000000 个字符。');
    const latest = get().artifacts.filter(item => item.taskId === task.id).sort((a, b) => b.version - a.version)[0];
    const retry = latest?.parentArtifactId === source.id && latest.content === content;
    if (latest?.id !== source.id && !retry) throw new Error('已有更新版本，请先选择最新版本再编辑。旧版本仍可查看和导出。');
    if (content === source.content || retry) { await get().retryStorage(); return retry ? latest.id : source.id; }
    if (task.artifactIds.length >= 50) throw new Error('每个任务最多保留 50 个版本，请新建任务。');
    const controller = new AbortController(), epoch = generation;
    artifactOperations.set(task.id, controller);
    try {
      const sha256 = await sha256Text(content);
      if (controller.signal.aborted || epoch !== generation || !get().unlocked) throw new Error('密钥库已锁定。');
      const id = crypto.randomUUID(), toolId = crypto.randomUUID(), now = new Date().toISOString();
      const artifact: WorkArtifact = { ...source, id, parentArtifactId: source.id, version: source.version + 1, content, sha256, createdAt: now };
      set(state => ({ artifacts: [...state.artifacts, artifact],
        toolRuns: [...state.toolRuns, { id: toolId, taskId: task.id, tool: 'document.edit', status: 'succeeded', sourceArtifactId: source.id, outputArtifactId: id, startedAt: now, finishedAt: now }],
        taskRuns: state.taskRuns.map(item => item.id === task.id ? { ...item, updatedAt: now, artifactIds: [...item.artifactIds, id], toolRunIds: [...item.toolRunIds, toolId] } : item) }));
      await persist(true);
      if (epoch !== generation || !get().unlocked) throw new Error('密钥库已锁定。');
      return id;
    } finally { if (artifactOperations.get(task.id) === controller) artifactOperations.delete(task.id); }
  },
  exportArtifactDocx: async (sourceId) => {
    if (!get().unlocked || !vault) throw new Error('请先解锁本机密钥库。');
    const source = get().artifacts.find(item => item.id === sourceId);
    const task = get().taskRuns.find(item => item.id === source?.taskId);
    if (!source || !task || task.status !== 'succeeded') throw new Error('源成果不存在或任务尚未完成。');
    if (artifactOperations.has(task.id)) throw new Error('此任务正在保存或导出，请稍后重试。');
    if (get().toolRuns.filter(item => item.taskId === task.id && item.tool === 'document.export-docx').length >= 100) throw new Error('每个任务最多保留 100 次 DOCX 导出记录。');
    const controller = new AbortController(), epoch = generation, toolId = crypto.randomUUID(), now = new Date().toISOString();
    artifactOperations.set(task.id, controller);
    const guard = () => { if (controller.signal.aborted || epoch !== generation || !get().unlocked) throw new Error('导出已取消或密钥库已锁定。'); };
    set(state => ({ toolRuns: [...state.toolRuns, { id: toolId, taskId: task.id, tool: 'document.export-docx', status: 'running', sourceArtifactId: source.id, startedAt: now }],
      taskRuns: state.taskRuns.map(item => item.id === task.id ? { ...item, toolRunIds: [...item.toolRunIds, toolId] } : item) }));
    try {
      await persist(true); guard();
      const { exportDocx } = await import('@/officeTasks/docxClient'); guard();
      const result = await exportDocx(source.content, task.title, controller.signal); guard();
      const hash = await crypto.subtle.digest('SHA-256', result.bytes); guard();
      const sha256 = Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
      const safeName = Array.from(source.name.replace(/\.md$/i, '')).map(char => char.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(char) ? '_' : char).join('').slice(0, 100);
      const name = `${safeName}-v${source.version}.docx`;
      set(state => ({ toolRuns: state.toolRuns.map(item => item.id === toolId ? { ...item, status: 'succeeded', finishedAt: new Date().toISOString(), outputSha256: sha256, outputName: name, converterVersion: result.converterVersion, warnings: result.warnings } : item) }));
      await persist(true); guard();
      return { bytes: result.bytes, name, warnings: result.warnings };
    } catch (error) {
      if (epoch === generation && get().unlocked) {
        set(state => ({ toolRuns: state.toolRuns.map(item => item.id === toolId ? { ...item, status: 'failed', finishedAt: new Date().toISOString(), error: 'DOCX 未能完成导出，请检查错误后重试。' } : item) }));
        await persist();
      }
      throw error;
    } finally { if (artifactOperations.get(task.id) === controller) artifactOperations.delete(task.id); }
  },
  removeTask: async (id) => {
    if (!get().unlocked || !vault) throw new Error('请先解锁本机密钥库。');
    if (artifactOperations.has(id)) throw new Error('此任务正在保存或导出，请稍后删除。');
    if (get().taskRuns.find(task => task.id === id)?.status === 'running') throw new Error('请先取消运行中的任务。');
    set(state => ({ taskRuns: state.taskRuns.filter(task => task.id !== id), toolRuns: state.toolRuns.filter(tool => tool.taskId !== id),
      artifacts: state.artifacts.filter(artifact => artifact.taskId !== id) }));
    await persist(true);
  },
  answerKnowledge: async (profileId, question, sources, allowCloud, signal) => {
    if (!get().unlocked) throw new Error('请先解锁本机密钥库。');
    const messages = buildKnowledgeMessages(question, sources);
    const profile = get().profiles.find(item => item.id === profileId);
    const secret = secrets.find(item => item.id === profileId);
    const account = profileId === ACCOUNT_MODEL_ID;
    if (account) {
      if (!get().accountModel || !useAuthStore.getState().isAuthenticated || get().accountModel?.userId !== useAuthStore.getState().user?.id) throw new Error('当前账号没有可用的云端模型，请先检查账号权限。');
    } else if (!profile || !secret) throw new Error('请选择已保存的生成模型连接。');
    if ((account || profile?.mode === 'relay') && !allowCloud) throw new Error('发送本地片段到云端前需要明确授权。');
    if (controllers.size >= 3) throw new Error('最多同时运行 3 个模型请求。');
    const id = `knowledge:${crypto.randomUUID()}`, controller = new AbortController(), epoch = generation;
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    controllers.set(id, controller); if (account || profile?.mode === 'relay') accountRequests.add(id);
    const timeout = setTimeout(abort, 120000);
    try {
      if (signal.aborted) abort();
      if (controller.signal.aborted) throw new DOMException('请求已取消', 'AbortError');
      const result = account ? await completeAccountModel(messages, controller.signal) : {
        content: await completeModel(profile!, secret!.apiKey, messages, controller.signal), model: profile!.model,
      };
      if (controller.signal.aborted || epoch !== generation) throw new DOMException('请求已取消或密钥库已锁定', 'AbortError');
      return result;
    } finally {
      clearTimeout(timeout); signal.removeEventListener('abort', abort); controllers.delete(id); accountRequests.delete(id);
    }
  },
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
