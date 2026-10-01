import type { TextBatchInput, TextBatchPlan, TextBatchPreview } from '@/fileOrganizer/textBatch';
import { artifactSeries } from '@/officeTasks/artifactSeries';
import { create } from "zustand";
import { PrivateVault, withVaultWriteLock } from "@/services/privateVault";
import { createVaultStorage, VAULT_CHANGE_CHANNEL, VAULT_WINDOW_ID } from '@/services/privateVaultStorage';
import type { VaultBackupSummary } from '@/services/vaultBackup';
import { completeModel, completeAccountModel, getAccountModel, validateProfile, validateModelEndpoint } from "@/services/workbenchModel";
import { discoverModels, type ModelCatalog, type ModelEndpoint } from '@/services/modelDiscovery';
import { useAuthStore } from "@/store/authStore";
import type { ModelProfile, TaskRun, ToolRun, VaultData, WorkArtifact, WorkConversation, WorkMessage } from "@/types/workbench";
import type { SearchHit } from '@/localKnowledge/core';
import { buildKnowledgeMessages, type KnowledgeTurn } from '@/localKnowledge/answer';
import { answerMarkdown, type KnowledgeAnswerArtifact } from '@/localKnowledge/answerArtifact';
import { buildDocumentMessages, documentExportContent, normalizeDocumentMarkdown, sha256Text, validateDocumentTask, type DocumentTaskInput } from '@/officeTasks/document';
import { generationPreview, type GenerationPreview } from '@/services/generationPreview';
import type { FinishReason } from '@/services/modelStream';
import { validateWorkflow, workflowOrder, type WorkflowDefinition, type WorkflowInput } from '@/workflows/definition';
import type { ChartInput } from '@/officeTasks/chart';
import { selectedPersonalItems, validatePersonalInput, type PersonalInput, type PersonalItem, type PersonalSelection } from '@/personal/items';
import { inputFromDraft, validatePersonalDraft, type PersonalDraft } from '@/personal/itemDraft';
import type { PersonalImportChoice, PersonalImportPlan, PersonalImportPreview, PersonalImportResult } from '@/personal/import';
import type { OrganizerDirectoryHandle } from '@/fileOrganizer/apply';
import { assertRunDirectories, undoPlan, type OrganizerRun } from '@/fileOrganizer/history';
import type { RenamePlan } from '@/fileOrganizer/plan';
import type { OfficeToolInput } from '@/officeTasks/toolRunner';
import type { DocxFormatOptions, DocxStyle } from '@/officeTasks/docxStyles';
import { completeToolModel, probeToolCallModel } from '@/services/officeToolModel';
import { reminderOwner, validateReminderDraft, validateReminderTemplate, type ReminderDraft, type ReminderTemplate } from '@/personal/reminderDraft';
import { withTextBatch, assertTextDirectory, assertVersionCapacity, draftText, readDirectoryText, snapshotText, textFormat, validateDraft, writeDirectoryText, type FileEditDraft, type FileEditVersion, type Newline, type TextSnapshot } from '@/fileOrganizer/textEdit';

export const VAULT_STORAGE_KEY = "geiit.workbench.encrypted.v1";
export const ACCOUNT_MODEL_ID = "$account";
let vault: PrivateVault | null = null;
let secrets: VaultData["profiles"] = [];
let generation = 0;
let textBatchGeneration = 0;
let textBatchPlan: { plan: TextBatchPlan; directory: OrganizerDirectoryHandle } | null = null;
let personalImportGeneration = 0;
let personalImportPlan: { id: string; plan: PersonalImportPlan } | null = null;
let transferGeneration = 0;
let preparedRestore: { id: string; expected: string | null; serialized: string } | null = null;
const controllers = new Map<string, AbortController>();
const artifactOperations = new Map<string, AbortController>();
const accountRequests = new Set<string>();
let accountLookup: AbortController | null = null;
// Disk compensation may outlive a locked vault. Keep this fence until it settles.
let organizerInFlight = false;
let reminderSaveTimer: ReturnType<typeof setTimeout> | undefined;
let reminderDraftVersion = 0;
let workflowDraftTimer: ReturnType<typeof setTimeout> | undefined;
let workflowDraftVersion = 0;
let personalSaveTimer: ReturnType<typeof setTimeout> | undefined;
let personalDraftVersion = 0;
function clearPersonalTimer() { clearTimeout(personalSaveTimer); personalSaveTimer = undefined; }
let fileEditTimer: ReturnType<typeof setTimeout> | undefined;
let fileEditDraftVersion = 0;
function clearFileEditTimer() { clearTimeout(fileEditTimer); fileEditTimer = undefined; }

function requireReminderOwner(owner: string) {
  const auth = useAuthStore.getState();
  if (!vault || !useWorkbenchStore.getState().unlocked || !auth.isAuthenticated || !auth.user || owner !== reminderOwner(auth.user.id, auth.user.email)) throw new Error('请解锁密钥库并使用草稿所属账号。');
}
function clearReminderTimer() { clearTimeout(reminderSaveTimer); reminderSaveTimer = undefined; }
function clearWorkflowDraftTimer() { clearTimeout(workflowDraftTimer); workflowDraftTimer = undefined; }

interface WorkbenchState {
  textBatchPreview: TextBatchPreview | null;
  prepareFileEditBatch: (directory: OrganizerDirectoryHandle, names: string[], rule: TextBatchInput, acknowledged: boolean, restoreBatchId?: string) => Promise<void>;
  commitFileEditBatch: (directory: OrganizerDirectoryHandle, id: string, selected: string[], acknowledged: boolean) => Promise<void>;
  cancelFileEditBatch: () => void;
  personalImportBusy: boolean;
  personalImportPreview: PersonalImportPreview | null;
  personalImportResult: (PersonalImportResult & { id: string; saved: boolean }) | null;
  preparePersonalImport: (file: Blob, name: string) => Promise<void>;
  commitPersonalImport: (id: string, choices: PersonalImportChoice[]) => Promise<void>;
  cancelPersonalImport: () => void;
  retryPersonalImport: () => Promise<void>;
  workflows: WorkflowDefinition[];
  workflowDraft: WorkflowDefinition | null;
  workflowDraftSaving: boolean;
  stageWorkflowDraft: (definition: WorkflowDefinition) => boolean;
  clearWorkflowDraft: () => Promise<void>;
  saveWorkflow: (definition: WorkflowDefinition) => Promise<WorkflowDefinition>;
  removeWorkflow: (id: string, revision: number) => Promise<void>;
  startWorkflow: (id: string, revision: number, input: WorkflowInput, profileId: string, allowCloud: boolean, resume?: { sourceTaskId: string; fromNodeId?: string }) => Promise<string>;
  resumeWorkflow: (taskId: string, fromNodeId: string | undefined, allowCloud: boolean) => Promise<string>;
  vaultTransferBusy: boolean;
  vaultRestorePreview: { id: string; replacing: boolean; summary: VaultBackupSummary } | null;
  exportWorkbenchBackup: (password: string, includeKeys: boolean) => Promise<{ file: Blob; summary: VaultBackupSummary }>;
  prepareWorkbenchRestore: (file: Blob, backupPassword: string, localPassword: string) => Promise<void>;
  commitWorkbenchRestore: (id: string) => Promise<void>;
  cancelVaultTransfer: () => void;
  fileEditDraft: FileEditDraft | null;
  fileEditVersions: FileEditVersion[];
  fileEditSaving: boolean;
  openFileEdit: (directory: OrganizerDirectoryHandle, name: string, acknowledged: boolean, restoreId?: string) => Promise<void>;
  stageFileEdit: (id: string, content: string, newline: Newline) => void;
  rebaseFileEdit: (id: string, current: TextSnapshot, content: string, newline: Exclude<Newline, 'mixed'>) => Promise<void>;
  discardFileEdit: (id: string) => Promise<void>;
  commitFileEdit: (directory: OrganizerDirectoryHandle, editId: string, acknowledged: boolean) => Promise<void>;
  inspectFileEdit: (directory: OrganizerDirectoryHandle, id: string, acknowledged: boolean) => Promise<void>;
  removeFileEditVersion: (id: string) => Promise<void>;
  reminderDrafts: ReminderDraft[];
  reminderTemplates: ReminderTemplate[];
  reminderDraftSaving: boolean;
  stageReminderDraft: (draft: ReminderDraft) => void;
  flushReminderDraft: () => Promise<void>;
  removeReminderDraft: (owner: string) => Promise<void>;
  saveReminderTemplate: (template: ReminderTemplate) => Promise<void>;
  removeReminderTemplate: (owner: string, id: string) => Promise<void>;
  organizerRuns: OrganizerRun[];
  organizerBusy: boolean;
  runFileOrganizer: (directory: OrganizerDirectoryHandle, plan: RenamePlan[], undoOf?: string, destination?: OrganizerDirectoryHandle) => Promise<string>;
  cancelFileOrganizer: () => void;
  inspectOrganizerRun: (directory: OrganizerDirectoryHandle, id: string, destination?: OrganizerDirectoryHandle) => Promise<void>;
  removeOrganizerRun: (id: string) => Promise<void>;
  personalItems: PersonalItem[];
  personalDrafts: PersonalDraft[];
  personalDraftSaving: boolean;
  stagePersonalDraft: (draft: PersonalDraft) => void;
  flushPersonalDrafts: () => Promise<void>;
  discardPersonalDraft: (id: string, editId: string) => Promise<void>;
  commitPersonalDraft: (id: string, editId: string) => Promise<PersonalItem>;
  archivePersonalItems: (selection: PersonalSelection[], archived: boolean) => Promise<void>;
  savePersonalItem: (id: string, input: PersonalInput, expectedRevision: number, draftEditId?: string) => Promise<PersonalItem>;
  removePersonalItem: (id: string, expectedRevision: number) => Promise<void>;
  unlocked: boolean;
  profiles: ModelProfile[];
  conversations: WorkConversation[];
  taskRuns: TaskRun[];
  toolRuns: ToolRun[];
  artifacts: WorkArtifact[];
  currentId: string | null;
  running: Record<string, boolean>;
  streamingContent: Record<string, string>;
  generationPreviews: Record<string, GenerationPreview>;
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
  testProfile: (id: string, signal?: AbortSignal) => Promise<void>;
  testProfileToolSupport: (id: string, signal?: AbortSignal) => Promise<void>;
  discoverProfileModels: (input: ModelEndpoint, apiKey: string, clearKey: boolean, signal: AbortSignal) => Promise<ModelCatalog>;
  newConversation: (profileId?: string) => string;
  select: (id: string) => void;
  rename: (id: string, title: string) => void;
  removeConversation: (id: string) => void;
  setProfile: (id: string, profileId: string) => void;
  send: (id: string, text: string) => Promise<void>;
  cancel: (id: string) => void;
  saveKnowledgeAnswer: (answer: KnowledgeAnswerArtifact) => Promise<string>;
  startDocumentTask: (profileId: string, input: DocumentTaskInput, allowCloud: boolean) => Promise<string>;
  startOfficeToolTask: (profileId: string, input: OfficeToolInput, allowCloud: boolean, allowWebSearch?: boolean) => Promise<string>;
  startChartTask: (input: ChartInput, requestId: string) => Promise<string>;
  cancelTask: (id: string) => void;
  removeTask: (id: string) => Promise<void>;
  saveArtifactVersion: (sourceId: string, content: string) => Promise<string>;
  restoreArtifactVersion: (sourceId: string, expectedLatestId: string) => Promise<string>;
  exportArtifactDocx: (sourceId: string, style?: DocxStyle, format?: DocxFormatOptions) => Promise<{ bytes: ArrayBuffer; name: string; warnings: string[] }>;
  retryStorage: () => Promise<void>;
  answerKnowledge: (profileId: string, question: string, sources: SearchHit[], allowCloud: boolean, signal: AbortSignal, onPreview?: (value: GenerationPreview | null) => void, history?: KnowledgeTurn[]) => Promise<{ content: string; model: string; finishReason: FinishReason }>;
}

function publicProfiles(): ModelProfile[] {
  return secrets.map(({ apiKey, ...profile }) => ({ ...profile, hasKey: Boolean(apiKey) }));
}

async function modelCapabilityFingerprint(profile: Pick<ModelProfile, 'mode' | 'baseUrl' | 'model' | 'maxTokens'>, apiKey: string): Promise<string> {
  return sha256Text(JSON.stringify({ mode: profile.mode, baseUrl: profile.baseUrl, model: profile.model, maxTokens: profile.maxTokens ?? null, apiKey }));
}

function keyForEndpoint(input: ModelEndpoint, apiKey: string, clearKey: boolean, baseUrl: string): string {
  const previous = secrets.find(profile => profile.id === input.id);
  const secret = clearKey ? '' : apiKey.trim() || previous?.apiKey || '';
  if (secret.length > 4096 || /[^\x21-\x7e]/.test(secret)) throw new Error('API Key 格式无效。');
  if (previous?.apiKey && (previous.baseUrl !== baseUrl || previous.mode !== input.mode) && !apiKey.trim() && !clearKey) {
    throw new Error('接口地址已改变，请重新填写 API Key 或勾选清除密钥。');
  }
  if (input.mode === 'relay' && !secret) throw new Error('云端模型需要 API Key。');
  return secret;
}

async function modelCheck<T>(mode: ModelProfile['mode'], signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (!useWorkbenchStore.getState().unlocked || !vault) throw new Error('请先解锁本机密钥库。');
  if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
  if (controllers.size >= 3) throw new Error('最多同时运行 3 个模型请求。');
  const controller = new AbortController(), epoch = generation, token = `check:${crypto.randomUUID()}`;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  controllers.set(token, controller);
  if (mode === 'relay') accountRequests.add(token);
  const timeout = setTimeout(abort, 25_000);
  try {
    const result = await operation(controller.signal);
    if (controller.signal.aborted || epoch !== generation) throw new DOMException('请求已取消或超时', 'AbortError');
    return result;
  } catch (error) {
    if (controller.signal.aborted || epoch !== generation) throw new DOMException('请求已取消或超时', 'AbortError');
    throw error;
  } finally {
    clearTimeout(timeout); signal?.removeEventListener('abort', abort);
    controllers.delete(token); accountRequests.delete(token);
  }
}

async function persist(required = false) {
  if (!vault || !useWorkbenchStore.getState().unlocked) {
    if (required) throw new Error('请先解锁本机密钥库。');
    return;
  }
  const epoch = generation;
  try {
    const draftVersion = personalDraftVersion, textVersion = fileEditDraftVersion, workflowVersion = workflowDraftVersion;
    await vault.save(vaultSnapshot());
    if (epoch === generation) {
      useWorkbenchStore.setState({ storageError: null });
      if (draftVersion === personalDraftVersion) { clearPersonalTimer(); useWorkbenchStore.setState({ personalDraftSaving: false }); }
      if (textVersion === fileEditDraftVersion) { clearFileEditTimer(); useWorkbenchStore.setState({ fileEditSaving: false }); }
      if (workflowVersion === workflowDraftVersion) { clearWorkflowDraftTimer(); useWorkbenchStore.setState({ workflowDraftSaving: false }); }
    }
  } catch (error) {
    const message = error instanceof Error && error.message.includes('超过 16 MiB 快照上限')
      ? error.message
      : "本机保存失败。请导出重要对话，并检查存储空间或其他窗口。";
    if (epoch === generation) useWorkbenchStore.setState({ storageError: message });
    if (required) throw new Error(message);
  }
}

function vaultSnapshot(): VaultData {
  const state = useWorkbenchStore.getState();
  return { workflows: state.workflows, workflowDraft: state.workflowDraft, profiles: secrets, conversations: state.conversations, taskRuns: state.taskRuns, toolRuns: state.toolRuns, artifacts: state.artifacts, personalItems: state.personalItems, personalDrafts: state.personalDrafts, organizerRuns: state.organizerRuns, reminderDrafts: state.reminderDrafts, reminderTemplates: state.reminderTemplates, fileEditDraft: state.fileEditDraft, fileEditVersions: state.fileEditVersions };
}

function eraseMemory() {
  textBatchGeneration++; textBatchPlan = null;
  personalImportGeneration++; personalImportPlan = null;
  transferGeneration++; preparedRestore = null;
  clearFileEditTimer();
  clearReminderTimer();
  clearPersonalTimer();
  generation++;
  for (const controller of controllers.values()) controller.abort();
  controllers.clear();
  for (const controller of artifactOperations.values()) controller.abort();
  artifactOperations.clear();
  secrets = [];
  vault?.lock();
  vault = null;
  clearWorkflowDraftTimer();
  useWorkbenchStore.setState({ unlocked: false, textBatchPreview: null, personalImportBusy: false, personalImportPreview: null, personalImportResult: null, workflows: [], workflowDraft: null, workflowDraftSaving: false, profiles: [], conversations: [], taskRuns: [], toolRuns: [], artifacts: [], personalItems: [], personalDrafts: [], personalDraftSaving: false, reminderDrafts: [], reminderTemplates: [], reminderDraftSaving: false, organizerRuns: [], organizerBusy: organizerInFlight, fileEditDraft: null, fileEditVersions: [], fileEditSaving: false, vaultTransferBusy: false, vaultRestorePreview: null, currentId: null, running: {}, streamingContent: {}, generationPreviews: {}, errors: {} });
}

// Edits and restores share the same task lock, immutable append and persistence semantics.
async function appendArtifactVersion(sourceId: string, change: { kind: 'edit'; content: string } | { kind: 'restore'; expectedLatestId: string }): Promise<string> {
  const get = useWorkbenchStore.getState, set = useWorkbenchStore.setState;
  if (!get().unlocked || !vault) throw new Error('请先解锁本机密钥库。');
  const source = get().artifacts.find(item => item.id === sourceId);
  const task = get().taskRuns.find(item => item.id === source?.taskId);
  if (!source || !task || (task.type === 'office.tools' ? task.status === 'running' : task.status !== 'succeeded')) throw new Error('源成果不存在或任务尚未完成。');
  if (source.kind !== 'markdown' || !['document.generate-markdown', 'office.tools'].includes(task.type)) throw new Error('仅 Markdown 文档支持版本编辑和恢复。');
  if (artifactOperations.has(task.id)) throw new Error('此任务正在保存或导出，请稍后重试。');
  const content = change.kind === 'edit' ? change.content : source.content;
  if (!content.trim() || content.length > 1_000_000 || content.includes('\0')) throw new Error('成果需要非空文本，最多 1000000 个字符。');
  const latest = task.type === 'document.generate-markdown'
    ? get().artifacts.filter(item => item.taskId === task.id).sort((a, b) => b.version - a.version)[0]
    : artifactSeries(source, get().artifacts)[0];
  const expectedId = change.kind === 'edit' ? source.id : change.expectedLatestId;
  const retry = latest?.parentArtifactId === expectedId && latest.content === content
    && (change.kind === 'restore' ? latest.restoredFromArtifactId === source.id : !latest.restoredFromArtifactId);
  if (latest?.id !== expectedId && !retry) throw new Error('已有更新版本，请重新查看最新版本后再操作。');
  const unchanged = content === latest.content || retry;
  if (!unchanged && task.artifactIds.length >= 50) throw new Error('每个任务最多保留 50 个版本或成果，请新建任务。');
  const controller = new AbortController(), epoch = generation;
  artifactOperations.set(task.id, controller);
  try {
    if (unchanged) { await get().retryStorage(); return latest.id; }
    const sha256 = await sha256Text(content);
    if (controller.signal.aborted || epoch !== generation || !get().unlocked) throw new Error('密钥库已锁定。');
    const id = crypto.randomUUID(), toolId = crypto.randomUUID(), now = new Date().toISOString();
    const artifact: WorkArtifact = { id, taskId: task.id, kind: 'markdown', name: latest.name, mimeType: 'text/markdown',
      parentArtifactId: latest.id, version: latest.version + 1, content, sha256, createdAt: now,
      ...(change.kind === 'restore' ? { restoredFromArtifactId: source.id, ...(source.finishReason ? { finishReason: source.finishReason } : {}) } : {}) };
    set(state => ({ artifacts: [...state.artifacts, artifact],
      toolRuns: [...state.toolRuns, { id: toolId, taskId: task.id, tool: change.kind === 'restore' ? 'document.restore' : 'document.edit',
        status: 'succeeded', sourceArtifactId: source.id, previousArtifactId: latest.id, outputArtifactId: id, startedAt: now, finishedAt: now }],
      taskRuns: state.taskRuns.map(item => item.id === task.id ? { ...item, updatedAt: now, artifactIds: [...item.artifactIds, id], toolRunIds: [...item.toolRunIds, toolId] } : item) }));
    await persist(true);
    if (epoch !== generation || !get().unlocked) throw new Error('密钥库已锁定。');
    return id;
  } finally { if (artifactOperations.get(task.id) === controller) artifactOperations.delete(task.id); }
}

export const useWorkbenchStore = create<WorkbenchState>((set, get) => ({
  vaultTransferBusy: false, vaultRestorePreview: null,
  cancelVaultTransfer: () => { transferGeneration++; preparedRestore = null; set({ vaultTransferBusy: false, vaultRestorePreview: null }); },
  exportWorkbenchBackup: async (password, includeKeys) => {
    if (!get().unlocked || !vault) throw new Error('请先解锁工作台再导出备份。');
    if (get().vaultTransferBusy || organizerInFlight || controllers.size || artifactOperations.size) throw new Error('请先等待或停止正在运行的模型、文件和导出操作。');
    // Capture immediately, including debounced drafts and unsaved changes after
    // quota errors. Export must remain usable when local persistence is full.
    const snapshot = JSON.parse(JSON.stringify(vaultSnapshot())) as VaultData;
    const epoch = generation, token = ++transferGeneration; set({ vaultTransferBusy: true });
    const guard = () => { if (epoch !== generation || token !== transferGeneration || !get().unlocked) throw new Error('备份已取消或密钥库已锁定。'); };
    try {
      const { exportVaultBackup } = await import('@/services/vaultBackup'); guard();
      const result = await exportVaultBackup(snapshot, password, includeKeys); guard(); return result;
    } finally { if (token === transferGeneration) set({ vaultTransferBusy: false }); }
  },
  prepareWorkbenchRestore: async (file, backupPassword, localPassword) => {
    if (get().unlocked || vault || organizerInFlight || get().vaultTransferBusy) throw new Error('请先锁定工作台并等待文件操作结束，再预检查恢复。');
    const epoch = generation, token = ++transferGeneration, storage = createVaultStorage();
    preparedRestore = null; set({ vaultTransferBusy: true, vaultRestorePreview: null });
    const guard = () => { if (epoch !== generation || token !== transferGeneration || get().unlocked || vault || organizerInFlight) throw new Error('恢复预检查已取消或工作台状态已改变。'); };
    try {
      const expected = await storage.getItem(VAULT_STORAGE_KEY); guard();
      const { prepareVaultReplacement } = await import('@/services/vaultBackup'); guard();
      const result = await prepareVaultReplacement(file, backupPassword, localPassword); guard();
      const current = await storage.getItem(VAULT_STORAGE_KEY); guard();
      if (current !== expected) throw new Error('预检查期间本机密钥库已改变，请重新预检查。');
      const id = crypto.randomUUID(); preparedRestore = { id, expected, serialized: result.serialized };
      set({ vaultRestorePreview: { id, replacing: expected !== null, summary: result.summary } });
    } finally { storage.close?.(); if (token === transferGeneration) set({ vaultTransferBusy: false }); }
  },
  commitWorkbenchRestore: async id => {
    if (get().unlocked || vault || organizerInFlight || get().vaultTransferBusy || !preparedRestore || preparedRestore.id !== id) throw new Error('请先锁定工作台并重新预检查备份。');
    const prepared = preparedRestore, epoch = generation, token = transferGeneration;
    set({ vaultTransferBusy: true });
    try {
      const storage = createVaultStorage();
      try { await withVaultWriteLock(VAULT_STORAGE_KEY, async () => {
        if (epoch !== generation || token !== transferGeneration || get().unlocked || vault || organizerInFlight || preparedRestore !== prepared) throw new Error('恢复已取消或状态已改变，请重新预检查。');
        if (await storage.getItem(VAULT_STORAGE_KEY) !== prepared.expected) throw new Error('本机密钥库已在其他窗口改变，请重新预检查，未覆盖新数据。');
        if (epoch !== generation || token !== transferGeneration || get().unlocked || vault || preparedRestore !== prepared) throw new Error('恢复已取消或状态已改变，请重新预检查。');
        try { await storage.setItem(VAULT_STORAGE_KEY, prepared.serialized, prepared.expected, () => {
          if (epoch !== generation || token !== transferGeneration || get().unlocked || vault || preparedRestore !== prepared) throw new Error('恢复已取消或状态已改变，请重新预检查。');
        }); }
        catch { throw new Error('本机空间不足或存储写入失败，原密钥库未更改。可释放空间后重试。'); }
      }); } finally { storage.close?.(); }
      // Replacing ciphertext neither unlocks the vault nor replays any task.
      eraseMemory(); set({ storageError: null });
    } finally { if (token === transferGeneration) set({ vaultTransferBusy: false }); }
  },
  cancelFileEditBatch: () => { textBatchGeneration++; textBatchPlan = null; set({ textBatchPreview: null }); },
  prepareFileEditBatch: async (directory, names, rule, acknowledged, restoreBatchId) => {
    if (!get().unlocked || !vault || organizerInFlight) throw new Error('请先解锁并等待文件操作完成。');
    if (get().storageError || get().fileEditDraft) throw new Error('请先保存本机记录并完成或丢弃单文件草稿。');
    get().cancelFileEditBatch(); const epoch = generation, request = textBatchGeneration;
    const selectedNames = [...names], selectedRule = rule ? structuredClone(rule) : null;
    organizerInFlight = true; set({ organizerBusy: true }); directory.retain?.();
    const guard = () => { if (epoch !== generation || request !== textBatchGeneration || !get().unlocked) throw new Error('批次读取已取消或密钥库已锁定。'); };
    try {
      const { prepareTextBatch } = await import('@/fileOrganizer/textBatch'); guard();
      const plan = await prepareTextBatch(directory, selectedNames, selectedRule, get().fileEditVersions, acknowledged, guard, restoreBatchId); guard();
      textBatchPlan = { plan, directory }; set({ textBatchPreview: { id: plan.id, directoryName: plan.directoryName, mode: plan.mode, rows: structuredClone(plan.rows) } });
    } finally { directory.release?.(); organizerInFlight = false; set({ organizerBusy: false }); }
  },
  commitFileEditBatch: async (directory, id, selected, acknowledged) => {
    if (!get().unlocked || !vault || organizerInFlight) throw new Error('请先解锁并等待文件操作完成。');
    if (get().storageError || get().fileEditDraft) throw new Error('请先保存本机记录并完成或丢弃单文件草稿。');
    const prepared = textBatchPlan;
    if (!prepared || prepared.plan.id !== id || prepared.directory !== directory) throw new Error('批次预览已失效，请重新读取。');
    const epoch = generation, request = textBatchGeneration, selection = [...selected], controller = new AbortController();
    organizerInFlight = true; set({ organizerBusy: true }); directory.retain?.(); artifactOperations.set('file-organizer', controller);
    const guard = () => { if (epoch !== generation || request !== textBatchGeneration || !get().unlocked || controller.signal.aborted) throw new Error('批次已停止；已发出的写入可能完成，请核验历史。'); };
    let currentId: string | undefined, finishedFile = false;
    try {
      const { batchVersions } = await import('@/fileOrganizer/textBatch');
      guard();
      const versions = batchVersions(prepared.plan, selection, get().fileEditVersions, new Date().toISOString());
      const drafts = selection.map(id => prepared.plan.rows.find(row => row.id === id)!.draft!);
      await withTextBatch(async access => {
        // Check the whole selection before registering any write; each file is
        // checked again just before its own write under the same operation lock.
        for (const draft of drafts) { guard(); await access.verify(directory, draft, acknowledged); }
        guard(); textBatchPlan = null;
        set(state => ({ textBatchPreview: null, fileEditVersions: [...versions, ...state.fileEditVersions] }));
        await persist(true); guard();
        for (let index = 0; index < versions.length; index++) {
          guard(); currentId = versions[index].id; finishedFile = false;
          await access.write(directory, drafts[index], versions[index].after, { acknowledged, guard, beforeWrite: async () => {
            guard(); set(state => ({ fileEditVersions: state.fileEditVersions.map(r => r.id === currentId ? { ...r, status: 'running', updatedAt: new Date().toISOString() } : r) }));
            await persist(true); guard();
          } });
          finishedFile = true;
          if (epoch !== generation || !get().unlocked) { guard(); }
          set(state => ({ fileEditVersions: state.fileEditVersions.map(r => r.id === currentId ? { ...r, status: 'succeeded', updatedAt: new Date().toISOString() } : r) }));
          await persist(true); guard();
        }
      });
    } catch (error) {
      if (!finishedFile && currentId && epoch === generation && get().unlocked) {
        set(state => ({ fileEditVersions: state.fileEditVersions.map(r => r.id === currentId && r.status === 'running' ? { ...r, status: 'needs-attention', updatedAt: new Date().toISOString(), error: error instanceof Error ? error.message : '写入未确认，请核验。' } : r) }));
        await persist();
      }
      throw error;
    } finally {
      directory.release?.(); if (artifactOperations.get('file-organizer') === controller) artifactOperations.delete('file-organizer');
      organizerInFlight = false; set({ organizerBusy: false });
    }
  },
  fileEditDraft: null, fileEditVersions: [], fileEditSaving: false,
  openFileEdit: async (directory, name, acknowledged, restoreId) => {
    if (!get().unlocked || !vault || organizerInFlight) throw new Error('请先解锁并等待文件操作完成。');
    if (get().fileEditDraft) throw new Error('请先完成或明确丢弃当前文本草稿。');
    if (get().storageError) throw new Error('请先重试本机保存。');
    const original = restoreId ? get().fileEditVersions.find(item => item.id === restoreId) : undefined;
    if (restoreId && (!original || original.name !== name)) throw new Error('恢复版本不存在或文件名不匹配。');
    if (original) assertTextDirectory(original, directory, acknowledged);
    const epoch = generation;
    organizerInFlight = true; set({ organizerBusy: true }); directory.retain?.();
    try {
      const before = await readDirectoryText(directory, name);
      if (epoch !== generation || !get().unlocked) throw new Error('密钥库已锁定。');
      const draft: FileEditDraft = { id: crypto.randomUUID(), editId: crypto.randomUUID(), name, directoryName: directory.name || '所选目录', directoryIdentity: directory.identity, before,
        ...textFormat(original?.before.text ?? before.text), ...(original ? { restoredFrom: original.id, restoreText: original.before.text } : {}) };
      validateDraft(draft); fileEditDraftVersion++; set({ fileEditDraft: draft, fileEditSaving: true });
      await persist(true);
    } finally { directory.release?.(); organizerInFlight = false; set({ organizerBusy: false }); }
  },
  stageFileEdit: (id, content, newline) => {
    if (!get().unlocked || !vault || organizerInFlight) throw new Error('请先解锁并等待文件操作完成。');
    const original = get().fileEditDraft;
    if (!original || original.id !== id) throw new Error('草稿已改变，请重新打开。');
    if (original.restoreText !== undefined) throw new Error('历史原文恢复预览不能直接修改，请完成或丢弃后重新编辑。');
    const draft = { ...original, content, newline, editId: crypto.randomUUID() };
    validateDraft(draft); fileEditDraftVersion++; set({ fileEditDraft: draft, fileEditSaving: true });
    clearFileEditTimer(); fileEditTimer = setTimeout(() => { fileEditTimer = undefined; void persist(); }, 400);
  },
  rebaseFileEdit: async (id, current, content, newline) => {
    if (!get().unlocked || !vault || organizerInFlight) throw new Error('请先解锁并等待文件操作完成。');
    if (get().storageError) throw new Error('请先重试本机保存。');
    const original = get().fileEditDraft;
    if (!original || original.id !== id) throw new Error('草稿已改变，请重新读取文件。');
    if (get().fileEditVersions.some(record => record.draftId === id && record.status !== 'not-applied')) throw new Error('此草稿已有写入记录，请先核验，不可重新合并。');
    if (original.before.identity && current.identity !== original.before.identity) throw new Error('文件身份已改变，不能自动合并。');
    const local = await snapshotText(draftText(original), original.before.identity);
    const merge = { base: original.before, local, current };
    const draft: FileEditDraft = { ...original, before: current, content, newline, bom: textFormat(current.text).bom, editId: crypto.randomUUID(), merge };
    delete draft.restoreText; delete draft.restoredFrom;
    validateDraft(draft); clearFileEditTimer(); fileEditDraftVersion++; set({ fileEditDraft: draft, fileEditSaving: true });
    await persist(true);
  },
  discardFileEdit: async id => {
    if (!get().unlocked || !vault || organizerInFlight) throw new Error('请先解锁并等待文件操作完成。');
    const draft = get().fileEditDraft, epoch = generation;
    if (!draft || draft.id !== id) throw new Error('草稿已改变。');
    clearFileEditTimer(); fileEditDraftVersion++; set({ fileEditDraft: null, fileEditSaving: true });
    try { await persist(true); }
    catch (error) {
      if (epoch === generation && get().unlocked && !get().fileEditDraft) { fileEditDraftVersion++; set({ fileEditDraft: draft, fileEditSaving: true }); }
      throw error;
    }
  },
  commitFileEdit: async (directory, editId, acknowledged) => {
    if (!get().unlocked || !vault || organizerInFlight) throw new Error('请先解锁并等待文件操作完成。');
    if (get().storageError) throw new Error('请先重试本机保存。');
    const draft = get().fileEditDraft;
    if (!draft || draft.editId !== editId) throw new Error('草稿已改变，请重新预览。');
    if (get().fileEditVersions.some(r => r.draftId === draft.id && r.status !== 'not-applied')) throw new Error('此草稿已有执行记录，请先核验；若已写入，请丢弃旧草稿并重新读取。');
    const text = draftText(draft);
    if (text === draft.before.text) throw new Error('文件内容没有变化。');
    const epoch = generation, controller = new AbortController();
    organizerInFlight = true; set({ organizerBusy: true }); directory.retain?.(); artifactOperations.set('file-organizer', controller);
    const guard = () => { if (epoch !== generation || !get().unlocked || controller.signal.aborted || get().fileEditDraft?.editId !== editId) throw new Error('密钥库已锁定、草稿已改变或操作已取消。'); };
    let id: string | undefined, finished = false;
    try {
      const after = await snapshotText(text, draft.before.identity); guard();
      const now = new Date().toISOString();
      const version: FileEditVersion = { id: crypto.randomUUID(), draftId: draft.id, name: draft.name, directoryName: draft.directoryName, directoryIdentity: draft.directoryIdentity,
        before: draft.before, after, status: 'running', createdAt: now, updatedAt: now, restoredFrom: draft.restoredFrom, merge: draft.merge };
      assertVersionCapacity(get().fileEditVersions, version);
      await writeDirectoryText(directory, draft, after, { acknowledged, guard, beforeWrite: async () => {
        guard(); id = version.id;
        set(state => ({ fileEditVersions: [version, ...state.fileEditVersions] }));
        await persist(true); guard();
      } });
      finished = true; guard(); fileEditDraftVersion++; clearFileEditTimer();
      set(state => ({ fileEditDraft: null, fileEditSaving: true, fileEditVersions: state.fileEditVersions.map(r => r.id === id ? { ...r, status: 'succeeded', updatedAt: new Date().toISOString() } : r) }));
      await persist(true);
      if (epoch !== generation || !get().unlocked) throw new Error('密钥库已锁定，请重新解锁查看结果。');
    } catch (error) {
      if (!finished && id && epoch === generation && get().unlocked) {
        set(state => ({ fileEditVersions: state.fileEditVersions.map(r => r.id === id ? { ...r, status: 'needs-attention', updatedAt: new Date().toISOString(), error: error instanceof Error ? error.message : '写入未完成，请核验文件。' } : r) }));
        await persist();
      }
      throw error;
    } finally {
      directory.release?.(); if (artifactOperations.get('file-organizer') === controller) artifactOperations.delete('file-organizer');
      organizerInFlight = false; set({ organizerBusy: false });
    }
  },
  inspectFileEdit: async (directory, id, acknowledged) => {
    if (!get().unlocked || !vault || organizerInFlight) throw new Error('请先解锁并等待文件操作完成。');
    const record = get().fileEditVersions.find(r => r.id === id), epoch = generation;
    if (!record) throw new Error('文本记录不存在。');
    assertTextDirectory(record, directory, acknowledged);
    organizerInFlight = true; set({ organizerBusy: true }); directory.retain?.();
    try {
      const current = await readDirectoryText(directory, record.name);
      if (epoch !== generation || !get().unlocked) throw new Error('密钥库已锁定。');
      const outcome = current.identity !== record.before.identity ? 'different' : current.sha256 === record.after.sha256 ? 'after' : current.sha256 === record.before.sha256 ? 'before' : 'different';
      const now = new Date().toISOString();
      set(state => ({ fileEditVersions: state.fileEditVersions.map(r => r.id === id ? { ...r, inspection: { outcome, checkedAt: now },
        ...(r.status === 'succeeded' || r.status === 'not-applied' || r.status === 'not-started' ? {} : { status: outcome === 'after' ? 'succeeded' : outcome === 'before' ? 'not-applied' : 'needs-attention', error: undefined }), updatedAt: now } : r) }));
      await persist(true);
    } finally { directory.release?.(); organizerInFlight = false; set({ organizerBusy: false }); }
  },
  removeFileEditVersion: async id => {
    if (!get().unlocked || !vault || organizerInFlight) throw new Error('请先解锁并等待文件操作完成。');
    const record = get().fileEditVersions.find(r => r.id === id);
    if (!record || !['succeeded', 'not-applied', 'not-started'].includes(record.status)) throw new Error('请先核验未完成的文本记录并保留恢复版本。');
    set(state => ({ fileEditVersions: state.fileEditVersions.filter(r => r.id !== id) })); await persist(true);
  },
  reminderDrafts: [], reminderTemplates: [], reminderDraftSaving: false,
  stageReminderDraft: draft => {
    requireReminderOwner(draft.owner); validateReminderDraft(draft);
    if (!get().reminderDrafts.some(item => item.owner === draft.owner) && get().reminderDrafts.length >= 20) throw new Error('本机最多保存 20 个账号的提醒草稿。');
    reminderDraftVersion++;
    set(state => ({ reminderDrafts: [structuredClone(draft), ...state.reminderDrafts.filter(item => item.owner !== draft.owner)], reminderDraftSaving: true }));
    clearReminderTimer();
    reminderSaveTimer = setTimeout(() => { reminderSaveTimer = undefined; void get().flushReminderDraft().catch(() => {}); }, 400);
  },
  flushReminderDraft: async () => {
    clearReminderTimer(); const epoch = generation, version = reminderDraftVersion;
    await persist(true);
    if (epoch !== generation || !get().unlocked) throw new Error('密钥库已锁定。');
    if (version === reminderDraftVersion) set({ reminderDraftSaving: false });
  },
  removeReminderDraft: async owner => {
    requireReminderOwner(owner); clearReminderTimer(); reminderDraftVersion++;
    const original = get().reminderDrafts.find(item => item.owner === owner), epoch = generation;
    set(state => ({ reminderDrafts: state.reminderDrafts.filter(item => item.owner !== owner), reminderDraftSaving: true }));
    try { await get().flushReminderDraft(); }
    catch (error) {
      if (original && epoch === generation && get().unlocked && !get().reminderDrafts.some(item => item.owner === owner)) set(state => ({ reminderDrafts: [original, ...state.reminderDrafts], reminderDraftSaving: true }));
      throw error;
    }
  },
  saveReminderTemplate: async template => {
    requireReminderOwner(template.owner); validateReminderTemplate(template);
    const existing = get().reminderTemplates.find(item => item.owner === template.owner && item.id === template.id);
    if (!existing && (get().reminderTemplates.filter(item => item.owner === template.owner).length >= 30 || get().reminderTemplates.length >= 100)) throw new Error('每个账号最多保存 30 个模板，本机最多 100 个。');
    const { id, owner, subject, body, timezone, recurrence } = template;
    set(state => ({ reminderTemplates: [{ id, owner, subject, body, timezone, recurrence, name: template.name.trim() }, ...state.reminderTemplates.filter(item => item !== existing)] }));
    await persist(true);
  },
  removeReminderTemplate: async (owner, id) => {
    requireReminderOwner(owner);
    set(state => ({ reminderTemplates: state.reminderTemplates.filter(item => item.owner !== owner || item.id !== id) }));
    await persist(true);
  },
  organizerRuns: [], organizerBusy: false,
  cancelFileOrganizer: () => { artifactOperations.get('file-organizer')?.abort(); },
  runFileOrganizer: async (directory, plan, undoOf, destination) => {
    if (!get().unlocked || !vault) throw new Error('请先解锁本机密钥库。');
    if (organizerInFlight) throw new Error('文件整理正在运行。');
    if (get().storageError) throw new Error('请先重试本机保存，避免丢失整理记录。');
    if (get().organizerRuns.length >= 100) throw new Error('最多保留 100 条整理记录，请先导出并删除不再需要的记录。');
    const original = undoOf ? get().organizerRuns.find(run => run.id === undoOf) : undefined;
    if (undoOf && !original) throw new Error('原整理记录不存在。');
    if (original) assertRunDirectories(original, directory, destination, true);
    if (undoOf && get().organizerRuns.some(run => run.undoOf === undoOf && ['running', 'interrupted', 'needs-attention', 'succeeded'].includes(run.status))) throw new Error('此记录已有撤销操作，请先核对其结果。');
    const selectedPlan = original ? undoPlan(original) : plan.map(item => ({ ...item }));
    const controller = new AbortController(), epoch = generation;
    organizerInFlight = true;
    artifactOperations.set('file-organizer', controller); set({ organizerBusy: true });
    let id: string | undefined, fileWorkFinished = false;
    directory.retain?.(); destination?.retain?.();
    try {
      const { applyRenamePlan } = await import('@/fileOrganizer/apply');
      const result = await applyRenamePlan(directory, selectedPlan, { destination, signal: controller.signal, beforeWrite: async prepared => {
        if (epoch !== generation || !get().unlocked || controller.signal.aborted) throw new Error('密钥库已锁定或操作已取消。');
        const now = new Date().toISOString(); id = prepared.id;
        const run: OrganizerRun = { ...prepared, directoryName: directory.name || '所选目录', directoryIdentity: directory.identity, destinationName: destination ? destination.name || '目标目录' : undefined, destinationIdentity: destination?.identity, kind: undoOf ? 'undo' : destination ? 'move' : 'rename', undoOf, status: 'running', createdAt: now, updatedAt: now };
        set(state => ({ organizerRuns: [run, ...state.organizerRuns] }));
        await persist(true);
      } });
      fileWorkFinished = true;
      if (epoch !== generation || !get().unlocked) throw new Error('操作期间密钥库已锁定，请重新解锁并核对执行记录。');
      set(state => ({ organizerRuns: state.organizerRuns.map(run => run.id === result.id ? { ...run, status: 'succeeded', updatedAt: new Date().toISOString(), retainedFiles: result.retainedFiles, warnings: result.warnings } : run.id === undoOf ? { ...run, status: 'undone', updatedAt: new Date().toISOString() } : run) }));
      await persist(true);
      if (epoch !== generation || !get().unlocked) throw new Error('密钥库已锁定，请重新解锁查看保存结果。');
      return result.id;
    } catch (error) {
      if (!fileWorkFinished && id && epoch === generation && get().unlocked) {
        const { OrganizerRecoveryError } = await import('@/fileOrganizer/apply');
        if (epoch === generation && get().unlocked) {
          set(state => ({ organizerRuns: state.organizerRuns.map(run => run.id === id ? { ...run, status: error instanceof OrganizerRecoveryError ? 'needs-attention' : 'failed', updatedAt: new Date().toISOString(), error: error instanceof Error ? error.message : '整理失败。', retainedFiles: error instanceof OrganizerRecoveryError ? error.retainedFiles : [] } : run) }));
          await persist();
        }
      }
      throw error;
    } finally {
      directory.release?.(); destination?.release?.();
      if (artifactOperations.get('file-organizer') === controller) artifactOperations.delete('file-organizer');
      organizerInFlight = false; set({ organizerBusy: false });
    }
  },
  removeOrganizerRun: async id => {
    if (!get().unlocked || !vault || organizerInFlight) throw new Error('请先解锁并等待文件整理完成。');
    const run = get().organizerRuns.find(item => item.id === id);
    if (!run || ['running', 'interrupted', 'needs-attention'].includes(run.status) || run.retainedFiles?.length) throw new Error('存在未核实结果或保留副本，请先核对目录，勿删除恢复记录。');
    if (get().organizerRuns.some(item => item.undoOf === id && ['running', 'interrupted', 'needs-attention'].includes(item.status))) throw new Error('关联撤销尚未核实，请先保留原记录。');
    set(state => ({ organizerRuns: state.organizerRuns.filter(item => item.id !== id) }));
    await persist(true);
  },
  inspectOrganizerRun: async (directory, id, destination) => {
    if (!get().unlocked || !vault || organizerInFlight) throw new Error('请先解锁并等待文件整理完成。');
    const run = get().organizerRuns.find(item => item.id === id), epoch = generation;
    if (!run || run.status === 'undone') throw new Error('记录不存在或已撤销。');
    assertRunDirectories(run, directory, destination);
    organizerInFlight = true; set({ organizerBusy: true });
    directory.retain?.(); destination?.retain?.();
    try {
      const { inspectRenameOutcome } = await import('@/fileOrganizer/apply');
      const result = await inspectRenameOutcome(directory, run.changes, destination);
      if (epoch !== generation || !get().unlocked) throw new Error('密钥库已锁定。');
      const status = result.outcome === 'applied' ? 'succeeded' : result.outcome === 'not-applied' ? 'failed' : 'needs-attention';
      const message = result.outcome === 'applied' ? undefined : result.outcome === 'not-applied' ? '已核验源文件完整，目标不存在；本次变更未应用。' : '目录与记录不完全匹配，请核对源文件、目标和暂存副本。';
      set(state => ({ organizerRuns: state.organizerRuns.map(item => item.id === id ? { ...item, status, error: message, retainedFiles: result.retainedFiles, updatedAt: new Date().toISOString() } : item.id === run.undoOf && status === 'succeeded' ? { ...item, status: 'undone', updatedAt: new Date().toISOString() } : item) }));
      await persist(true);
    } finally { directory.release?.(); destination?.release?.(); organizerInFlight = false; set({ organizerBusy: false }); }
  },
  personalItems: [], personalDrafts: [], personalDraftSaving: false,
  preparePersonalImport: async (file, name) => {
    if (!get().unlocked || !vault) throw new Error('请先解锁本机密钥库。');
    if (get().personalImportBusy) throw new Error('导入操作仍在处理。');
    if (get().storageError || get().personalImportResult && !get().personalImportResult!.saved) throw new Error('请先重试本机保存，确认已有导入结果已保存。');
    const epoch = generation, request = ++personalImportGeneration;
    personalImportPlan = null; set({ personalImportBusy: true, personalImportPreview: null, personalImportResult: null });
    const active = () => epoch === generation && request === personalImportGeneration && get().unlocked;
    try {
      const { readPersonalImport, planPersonalImport } = await import('@/personal/import');
      if (!active()) return;
      const data = await readPersonalImport(file);
      if (!active()) return;
      const plan = planPersonalImport(data, get().personalItems, get().personalDrafts), id = crypto.randomUUID();
      personalImportPlan = { id, plan };
      set({ personalImportPreview: { id, name: name.slice(0, 255), kind: data.kind, ...(data.kind !== 'draft' ? { exportedAt: data.exportedAt } : {}), rows: structuredClone(plan.rows) } });
    } finally { if (active()) set({ personalImportBusy: false }); }
  },
  cancelPersonalImport: () => {
    personalImportGeneration++; personalImportPlan = null;
    set({ personalImportBusy: false, personalImportPreview: null });
  },
  commitPersonalImport: async (id, choices) => {
    if (!get().unlocked || !vault) throw new Error('请先解锁本机密钥库。');
    if (get().personalImportBusy || get().storageError) throw new Error('请等待导入处理结束并确认本机保存正常。');
    const prepared = personalImportPlan, epoch = generation, request = personalImportGeneration;
    if (!prepared || prepared.id !== id) throw new Error('预检查已失效，请重新选择文件。');
    const selected = structuredClone(choices); set({ personalImportBusy: true });
    const active = () => epoch === generation && request === personalImportGeneration && get().unlocked;
    try {
      const { applyPersonalImport } = await import('@/personal/import');
      if (!active() || personalImportPlan !== prepared) throw new Error('导入预检查已取消。');
      const next = applyPersonalImport(prepared.plan, selected, get().personalItems, get().personalDrafts, new Date().toISOString());
      // Consume once before the write. A quota failure retains the same applied
      // in-memory result; retry only persists it and cannot recreate copies.
      personalImportPlan = null;
      if (next.result.drafts) personalDraftVersion++;
      set({ personalImportPreview: null, personalItems: next.items, personalDrafts: next.drafts,
        ...(next.result.drafts ? { personalDraftSaving: true } : {}), personalImportResult: { ...next.result, id, saved: false } });
      await persist(true);
      if (!active()) throw new Error('密钥库已锁定或导入页面已离开，请重新打开核对导入结果。');
      set({ personalImportResult: { ...next.result, id, saved: true } });
    } finally { if (active()) set({ personalImportBusy: false }); }
  },
  retryPersonalImport: async () => {
    const previous = get().personalImportResult, epoch = generation;
    if (!get().unlocked || !vault || get().personalImportBusy) throw new Error('请先解锁并等待当前导入结束。');
    if (!previous || previous.saved) throw new Error('没有等待保存的导入结果。');
    set({ personalImportBusy: true });
    try {
      await get().retryStorage();
      if (epoch === generation && get().personalImportResult?.id === previous.id) set({ personalImportResult: { ...previous, saved: true } });
    } finally { if (epoch === generation && get().unlocked) set({ personalImportBusy: false }); }
  },
  stagePersonalDraft: draft => {
    if (!get().unlocked || !vault) throw new Error('请先解锁本机密钥库。');
    validatePersonalDraft(draft);
    if (!get().personalDrafts.some(item => item.id === draft.id) && get().personalDrafts.length >= 100) throw new Error('最多保留 100 条草稿，请先保存或丢弃不需要的草稿。');
    personalDraftVersion++;
    set(state => ({ personalDrafts: [structuredClone(draft), ...state.personalDrafts.filter(item => item.id !== draft.id)], personalDraftSaving: true }));
    clearPersonalTimer(); personalSaveTimer = setTimeout(() => { personalSaveTimer = undefined; void get().flushPersonalDrafts().catch(() => {}); }, 400);
  },
  flushPersonalDrafts: async () => {
    clearPersonalTimer(); const epoch = generation;
    await persist(true);
    if (epoch !== generation || !get().unlocked) throw new Error('密钥库已锁定。');
  },
  discardPersonalDraft: async (id, editId) => {
    if (!get().unlocked || !vault) throw new Error('请先解锁本机密钥库。');
    const draft = get().personalDrafts.find(item => item.id === id), epoch = generation;
    if (!draft || draft.editId !== editId) throw new Error('草稿已改变，请重新打开。');
    clearPersonalTimer(); personalDraftVersion++;
    set(state => ({ personalDrafts: state.personalDrafts.filter(item => item.id !== id), personalDraftSaving: true }));
    try { await get().flushPersonalDrafts(); }
    catch (error) {
      if (epoch === generation && get().unlocked && !get().personalDrafts.some(item => item.id === id)) {
        personalDraftVersion++; set(state => ({ personalDrafts: [draft, ...state.personalDrafts], personalDraftSaving: true }));
      }
      throw error;
    }
  },
  commitPersonalDraft: async (id, editId) => {
    const draft = get().personalDrafts.find(item => item.id === id), epoch = generation;
    if (!draft || draft.editId !== editId) throw new Error('草稿已改变，请重新打开。');
    const input = inputFromDraft(draft);
    // Preserve the raw edit before replacing it with a validated record. A lost
    // final write therefore leaves either the old draft or the committed record.
    await get().flushPersonalDrafts();
    if (epoch !== generation || !get().unlocked) throw new Error('密钥库已锁定。');
    return get().savePersonalItem(id, input, draft.baseRevision, editId);
  },
  archivePersonalItems: async (selection, archived) => {
    if (!get().unlocked || !vault) throw new Error('请先解锁本机密钥库。');
    if (get().storageError) throw new Error('请先重试本机保存。');
    const items = selectedPersonalItems(get().personalItems, selection), ids = new Set(items.map(item => item.id));
    if (get().personalDrafts.some(draft => ids.has(draft.id))) throw new Error('所选记录有未保存草稿，请先保存或丢弃草稿。');
    const epoch = generation, now = new Date().toISOString();
    set(state => ({ personalItems: state.personalItems.map(item => ids.has(item.id) && !!item.archivedAt !== archived ? { ...item, archivedAt: archived ? now : null, updatedAt: now, revision: item.revision + 1 } : item) }));
    await persist(true);
    if (epoch !== generation || !get().unlocked) throw new Error('密钥库已锁定，请重新解锁查看归档结果。');
  },
  savePersonalItem: async (id, input, expectedRevision, draftEditId) => {
    if (!get().unlocked || !vault) throw new Error('请先解锁本机密钥库。');
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('记录标识无效。');
    const clean = validatePersonalInput(input), existing = get().personalItems.find(item => item.id === id);
    if (existing?.archivedAt) throw new Error('请先恢复已归档记录，再编辑。');
    if (draftEditId && get().personalDrafts.find(item => item.id === id)?.editId !== draftEditId) throw new Error('草稿已改变，请重新打开。');
    if ((existing?.revision ?? 0) !== expectedRevision) throw new Error('记录已改变，请重新打开后编辑。');
    if (existing && existing.kind !== clean.kind) throw new Error('不能更改记录类型。');
    if (!existing && get().personalItems.length >= 500) throw new Error('最多保留 500 条笔记和待办，请导出并删除不需要的记录。');
    const now = new Date().toISOString(), epoch = generation;
    const item: PersonalItem = { ...clean, id, revision: expectedRevision + 1, createdAt: existing?.createdAt ?? now, updatedAt: now,
      completedAt: clean.kind === 'todo' && clean.status === 'done' ? existing?.completedAt ?? now : null };
    if (draftEditId) personalDraftVersion++;
    set(state => ({ personalItems: [item, ...state.personalItems.filter(value => value.id !== id)],
      ...(draftEditId ? { personalDrafts: state.personalDrafts.filter(draft => draft.id !== id || draft.editId !== draftEditId), personalDraftSaving: true } : {}) }));
    await persist(true);
    if (epoch !== generation || !get().unlocked) throw new Error('密钥库已锁定，请重新解锁查看保存结果。');
    return item;
  },
  removePersonalItem: async (id, expectedRevision) => {
    if (!get().unlocked || !vault) throw new Error('请先解锁本机密钥库。');
    const item = get().personalItems.find(value => value.id === id);
    if (!item || item.revision !== expectedRevision) throw new Error('记录已改变，请重新打开后删除。');
    const epoch = generation;
    set(state => ({ personalItems: state.personalItems.filter(value => value.id !== id) }));
    await persist(true);
    if (epoch !== generation || !get().unlocked) throw new Error('密钥库已锁定，请重新解锁查看删除结果。');
  },
  unlocked: false, textBatchPreview: null, personalImportBusy: false, personalImportPreview: null, personalImportResult: null, workflows: [], workflowDraft: null, workflowDraftSaving: false, profiles: [], conversations: [], taskRuns: [], toolRuns: [], artifacts: [], currentId: null, running: {}, streamingContent: {}, generationPreviews: {}, errors: {}, storageError: null,
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
    if (get().vaultTransferBusy) throw new Error('备份或恢复处理中，请先等待或取消。');
    get().cancelVaultTransfer();
    const epoch = ++generation;
    const candidate = new PrivateVault(createVaultStorage(), VAULT_STORAGE_KEY);
    let data;
    try { data = await candidate.unlock(password); }
    catch (error) { candidate.lock(); throw error; }
    if (epoch !== generation) { candidate.lock(); return; }
    vault = candidate;
    secrets = data.profiles;
    const unlockedAt = new Date().toISOString();
    const taskRuns = (data.taskRuns ?? []).map(task => task.status === 'running' ? { ...task, status: 'interrupted' as const, updatedAt: unlockedAt,
      error: '客户端在任务完成前关闭或锁定；已保存的部分成果保留，请核对执行记录。' } : task);
    const toolRuns = (data.toolRuns ?? []).map(tool => tool.status === 'running' ? { ...tool, status: 'interrupted' as const, finishedAt: unlockedAt,
      error: '客户端在工具调用完成前关闭或锁定。' } : tool);
    const organizerRuns = (data.organizerRuns ?? []).map(run => run.status === 'running' ? { ...run, status: 'interrupted' as const, updatedAt: unlockedAt, error: '操作中断，文件可能已部分变更；请核对目录和暂存副本，勿直接重新执行。' } : run);
    const fileEditVersions = (data.fileEditVersions ?? []).map(r => r.status === 'running' ? { ...r, status: 'interrupted' as const, updatedAt: unlockedAt, error: '写入期间中断，文件可能已经变更；请先核验，不自动重放。' } : r);
    set({ unlocked: true, textBatchPreview: null, personalImportBusy: false, personalImportPreview: null, personalImportResult: null, workflows: data.workflows ?? [], workflowDraft: data.workflowDraft ?? null, workflowDraftSaving: false, profiles: publicProfiles(), conversations: data.conversations, taskRuns, toolRuns, artifacts: data.artifacts ?? [], personalItems: data.personalItems ?? [], personalDrafts: data.personalDrafts ?? [], personalDraftSaving: false, reminderDrafts: data.reminderDrafts ?? [], reminderTemplates: data.reminderTemplates ?? [], reminderDraftSaving: false, organizerRuns, organizerBusy: organizerInFlight, fileEditDraft: data.fileEditDraft ?? null, fileEditVersions, fileEditSaving: false,
      currentId: data.conversations[0]?.id ?? null, running: {}, streamingContent: {}, generationPreviews: {}, errors: {}, storageError: null });
    if (taskRuns.some((task, index) => task !== (data.taskRuns ?? [])[index]) || toolRuns.some((tool, index) => tool !== (data.toolRuns ?? [])[index]) || organizerRuns.some((run, index) => run !== data.organizerRuns?.[index]) || fileEditVersions.some((r, i) => r !== data.fileEditVersions?.[i])) await persist();
  },
  lock: async () => {
    get().cancelVaultTransfer(); get().cancelPersonalImport(); get().cancelFileEditBatch();
    // Queue the current draft snapshot before clearing memory; flush below waits
    // for it even when the 400 ms autosave debounce has not elapsed.
    if (get().unlocked && (get().reminderDraftSaving || get().personalDraftSaving || get().fileEditSaving || get().workflowDraftSaving)) { clearReminderTimer(); clearPersonalTimer(); clearFileEditTimer(); clearWorkflowDraftTimer(); void persist().catch(() => {}); }
    const epoch = ++generation;
    const lockingVault = vault;
    for (const controller of controllers.values()) controller.abort();
    for (const controller of artifactOperations.values()) controller.abort();
    set({ unlocked: false, textBatchPreview: null, personalImportBusy: false, personalImportPreview: null, personalImportResult: null, workflows: [], workflowDraft: null, workflowDraftSaving: false, profiles: [], conversations: [], taskRuns: [], toolRuns: [], artifacts: [], personalItems: [], personalDrafts: [], personalDraftSaving: false, reminderDrafts: [], reminderTemplates: [], reminderDraftSaving: false, organizerRuns: [], fileEditDraft: null, fileEditVersions: [], fileEditSaving: false, currentId: null, running: {}, streamingContent: {}, generationPreviews: {}, errors: {} });
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
    const secret = keyForEndpoint(input, apiKey, clearKey, baseUrl);
    const configChanged = !previous || previous.mode !== input.mode || previous.baseUrl !== baseUrl || previous.model !== input.model.trim() || previous.maxTokens !== input.maxTokens || previous.apiKey !== secret;
    const profile = { ...input, name: input.name.trim(), model: input.model.trim(), baseUrl, apiKey: secret,
      textTestedAt: configChanged ? undefined : previous.textTestedAt,
      toolTestedAt: configChanged ? undefined : previous.toolTestedAt,
      capabilities: configChanged ? undefined : previous.capabilities };
    const next = [...secrets.filter((item) => item.id !== input.id), profile];
    secrets = next;
    set({ profiles: publicProfiles() });
    await persist(true);
  },
  removeProfile: async (id) => {
    if (Object.keys(get().running).some((cid) => get().running[cid] && get().conversations.find((c) => c.id === cid)?.profileId === id)) {
      throw new Error("此连接仍有运行中的对话。");
    }
    if (get().workflows.some(workflow => workflow.nodes.some(node => node.profileId === id))
      || get().taskRuns.some(task => task.status === 'running' && (task.profileId === id || task.workflow?.definition.nodes.some(node => node.profileId === id)))) {
      throw new Error('此连接仍被已保存或运行中的工作流引用。');
    }
    if (!vault) return;
    const next = secrets.filter((profile) => profile.id !== id);
    secrets = next;
    set({ profiles: publicProfiles() });
    await persist(true);
  },
  discoverProfileModels: async (input, apiKey, clearKey, signal) => {
    if (!get().unlocked || !vault) throw new Error('请先解锁本机密钥库。');
    const baseUrl = validateModelEndpoint(input);
    const secret = keyForEndpoint(input, apiKey, clearKey, baseUrl);
    return modelCheck(input.mode, signal, requestSignal => discoverModels({ ...input, baseUrl }, secret, requestSignal));
  },
  testProfile: async (id, signal) => {
    const profile = get().profiles.find((item) => item.id === id);
    const secret = secrets.find((item) => item.id === id);
    if (!profile || !secret) throw new Error("请先保存模型连接。");
    const epoch = generation, testedSecret = secret.apiKey;
    await modelCheck(profile.mode, signal, requestSignal => completeModel(profile, secret.apiKey, [{ role: "user", content: "Reply OK." }], requestSignal));
    const current = secrets.find(item => item.id === id);
    const currentPublic = get().profiles.find(item => item.id === id);
    if (epoch !== generation || !get().unlocked || !vault || current?.apiKey !== testedSecret || !currentPublic || currentPublic.mode !== profile.mode || currentPublic.baseUrl !== profile.baseUrl || currentPublic.model !== profile.model || currentPublic.maxTokens !== profile.maxTokens) {
      throw new DOMException('连接配置已改变，测试结果未保存。', 'AbortError');
    }
    const testedAt = new Date().toISOString();
    const fingerprint = await modelCapabilityFingerprint(profile, testedSecret);
    const updated = { ...current, textTestedAt: testedAt, capabilities: { ...current?.capabilities, text: { state: 'supported' as const, testedAt, fingerprint } } };
    secrets = secrets.map(item => item.id === id ? updated : item);
    set({ profiles: publicProfiles() });
    try {
      await persist(true);
    } catch (error) {
      if (epoch === generation && secrets.find(item => item.id === id) === updated) {
        secrets = secrets.map(item => item.id === id ? current : item);
        set({ profiles: publicProfiles() });
      }
      throw error;
    }
  },
  testProfileToolSupport: async (id, signal) => {
    const profile = get().profiles.find(item => item.id === id), secret = secrets.find(item => item.id === id);
    if (!profile || !secret) throw new Error('请先保存模型连接。');
    const epoch = generation, testedSecret = secret.apiKey;
    await modelCheck(profile.mode, signal, requestSignal => probeToolCallModel(profile, secret.apiKey, requestSignal));
    const current = secrets.find(item => item.id === id), currentPublic = get().profiles.find(item => item.id === id);
    if (epoch !== generation || !get().unlocked || !vault || current?.apiKey !== testedSecret || !currentPublic
      || currentPublic.mode !== profile.mode || currentPublic.baseUrl !== profile.baseUrl || currentPublic.model !== profile.model || currentPublic.maxTokens !== profile.maxTokens) {
      throw new DOMException('连接配置已改变，测试结果未保存。', 'AbortError');
    }
    const testedAt = new Date().toISOString(), fingerprint = await modelCapabilityFingerprint(profile, testedSecret), updated = { ...current, toolTestedAt: testedAt, capabilities: { ...current?.capabilities, toolCalls: { state: 'supported' as const, testedAt, fingerprint } } };
    secrets = secrets.map(item => item.id === id ? updated : item); set({ profiles: publicProfiles() });
    try { await persist(true); }
    catch (error) {
      if (epoch === generation && secrets.find(item => item.id === id) === updated) { secrets = secrets.map(item => item.id === id ? current : item); set({ profiles: publicProfiles() }); }
      throw error;
    }
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
    if (useAccount || profile?.mode === 'relay') accountRequests.add(id);
    const epoch = generation;
    const timeout = setTimeout(() => controller.abort(), 120_000);
    set((state) => ({
      conversations: state.conversations.map((c) => c.id === id ? { ...c, profileId: useAccount ? ACCOUNT_MODEL_ID : c.profileId, messages, title: c.messages.length ? c.title : text.trim().slice(0, 28), updatedAt: userMessage.createdAt } : c),
      running: { ...state.running, [id]: true }, streamingContent: { ...state.streamingContent, [id]: "" }, errors: { ...state.errors, [id]: "" },
    }));
    await persist();
    try {
      if (epoch !== generation || controller.signal.aborted) return;
      const input = messages.map(({ role, content }) => ({ role, content }));
      const onChunk = (chunk: string) => {
        if (epoch !== generation || controller.signal.aborted || !get().unlocked || controllers.get(id) !== controller) return;
        set(state => ({ streamingContent: { ...state.streamingContent, [id]: (state.streamingContent[id] ?? '') + chunk } }));
      };
      let finishReason: WorkMessage['finishReason'] = 'unknown';
      const onFinish = (reason: NonNullable<WorkMessage['finishReason']>) => { finishReason = reason; };
      const result = useAccount ? await completeAccountModel(input, controller.signal, onChunk, onFinish) : {
        content: await completeModel(profile!, secret!.apiKey, input, controller.signal, onChunk, onFinish), model: profile!.model,
      };
      if (epoch !== generation || controller.signal.aborted) return;
      const message: WorkMessage = { id: crypto.randomUUID(), role: "assistant", ...result, finishReason, createdAt: new Date().toISOString() };
      set((state) => ({ conversations: state.conversations.map((c) => c.id === id ? { ...c, messages: [...c.messages, message], updatedAt: message.createdAt } : c) }));
      await persist();
    } catch (error) {
      if (epoch === generation) set((state) => ({ errors: { ...state.errors, [id]: controller.signal.aborted ? "请求已停止或超时。" : error instanceof Error ? error.message : "模型请求失败。" } }));
    } finally {
      clearTimeout(timeout);
      if (controllers.get(id) === controller) accountRequests.delete(id);
      if (epoch === generation) {
        controllers.delete(id);
        set((state) => { const streamingContent = { ...state.streamingContent }; delete streamingContent[id]; return { running: { ...state.running, [id]: false }, streamingContent }; });
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
        messages: [{ id: answer.id, role: 'assistant', model: answer.model, createdAt: answer.createdAt, content: answerMarkdown(answer), ...(answer.finishReason ? { finishReason: answer.finishReason } : {}) }] };
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
    let finishReason: FinishReason = 'unknown';
    const onFinish = (reason: FinishReason) => { finishReason = reason; };
    const preview = generationPreview(controller.signal, () => epoch === generation && get().unlocked && controllers.get(token) === controller, value => {
      if (epoch !== generation) return;
      set(state => {
        const generationPreviews = { ...state.generationPreviews };
        if (value) generationPreviews[id] = value; else delete generationPreviews[id];
        return { generationPreviews };
      });
    });
    try {
      if (controller.signal.aborted || epoch !== generation || !get().unlocked) throw new DOMException('任务已取消或密钥库已锁定', 'AbortError');
      const result = account ? await completeAccountModel(messages, controller.signal, preview.push, onFinish) : {
        content: await completeModel(profile!, secret!.apiKey, messages, controller.signal, preview.push, onFinish), model: profile!.model,
      };
      if (controller.signal.aborted || epoch !== generation) throw new DOMException('任务已取消或密钥库已锁定', 'AbortError');
      const content = normalizeDocumentMarkdown(result.content), completedAt = new Date().toISOString();
      const artifact: WorkArtifact = { id: crypto.randomUUID(), taskId: id, kind: 'markdown', version: 1,
        name: `${clean.title.replace(/[<>:"/\\|?*]/g, '_') || 'document'}.md`, mimeType: 'text/markdown', content,
        sha256: await sha256Text(content), createdAt: completedAt, finishReason };
      if (controller.signal.aborted || epoch !== generation) throw new DOMException('任务已取消或密钥库已锁定', 'AbortError');
      set(state => ({ artifacts: [artifact, ...state.artifacts],
        taskRuns: state.taskRuns.map(item => item.id === id ? { ...item, status: 'succeeded', updatedAt: completedAt, artifactIds: [artifact.id], error: undefined } : item),
        toolRuns: state.toolRuns.map(item => item.id === toolId ? { ...item, status: 'succeeded', model: result.model, finishReason, finishedAt: completedAt, error: undefined } : item) }));
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
      preview.dispose(); clearTimeout(timeout); controllers.delete(token); accountRequests.delete(token);
    }
  },
  startOfficeToolTask: async (profileId, input, allowCloud, allowWebSearch = false) => {
    const epoch = generation;
    if (!get().unlocked || !vault) throw new Error('请先解锁本机密钥库。');
    const { validateOfficeToolInput, runOfficeTools } = await import('@/officeTasks/toolRunner');
    if (epoch !== generation || !get().unlocked || !vault) throw new Error('密钥库已锁定。');
    const clean = validateOfficeToolInput(input), profile = get().profiles.find(item => item.id === profileId), secret = secrets.find(item => item.id === profileId);
    const account = profileId === ACCOUNT_MODEL_ID;
    if (account) {
      if (!get().accountModel || !useAuthStore.getState().isAuthenticated || get().accountModel?.userId !== useAuthStore.getState().user?.id) throw new Error('当前账号没有可用的云端模型。');
    } else if (!profile || !secret) throw new Error('请选择已保存的模型连接。');
    if ((account || profile?.mode === 'relay') && !allowCloud) throw new Error('本次多轮请求会发送任务材料及工具结果到云端，需要明确授权。');
    if (controllers.size >= 3) throw new Error('最多同时运行 3 个模型请求。');
    if (get().taskRuns.length >= 100) throw new Error('最多保留 100 个办公任务，请先删除旧任务。');
    const id = crypto.randomUUID(), token = `task:${id}`, now = new Date().toISOString(), controller = new AbortController();
    controllers.set(token, controller); if (account || profile?.mode === 'relay') accountRequests.add(token);
    const guard = () => { if (controller.signal.aborted || epoch !== generation || !get().unlocked) throw new DOMException('任务已取消或密钥库已锁定', 'AbortError'); };
    set(state => ({ taskRuns: [{ id, type: 'office.tools', officeInput: clean, title: clean.title, instruction: clean.instruction, profileId,
      status: 'running', createdAt: now, updatedAt: now, toolRunIds: [], artifactIds: [] }, ...state.taskRuns] }));
    const timeout = setTimeout(() => controller.abort(), 360000);
    try {
      await persist(true); guard();
      const summary = await runOfficeTools(id, clean, controller.signal, async messages => {
        guard();
        const round = new AbortController(), abort = () => round.abort();
        controller.signal.addEventListener('abort', abort, { once: true });
        const roundTimeout = setTimeout(abort, 120000);
        try {
          const reply = await completeToolModel(account ? null : profile!, secret?.apiKey || '', messages, round.signal, allowWebSearch);
          guard(); if (round.signal.aborted) throw new Error('本轮模型请求已超时。'); return reply;
        } catch (error) {
          guard();
          if (round.signal.aborted) throw new Error('本轮模型请求已超时；已保存成果保留。');
          throw error;
        } finally { clearTimeout(roundTimeout); controller.signal.removeEventListener('abort', abort); }
      }, async ({ step, artifact }) => {
        guard();
        set(state => ({
          toolRuns: [...state.toolRuns.filter(item => item.id !== step.id), step],
          artifacts: artifact ? [artifact, ...state.artifacts] : state.artifacts,
          taskRuns: state.taskRuns.map(task => task.id !== id ? task : { ...task, updatedAt: new Date().toISOString(),
            toolRunIds: task.toolRunIds.includes(step.id) ? task.toolRunIds : [...task.toolRunIds, step.id], artifactIds: artifact ? [...task.artifactIds, artifact.id] : task.artifactIds }),
        }));
        await persist(true); guard();
      }, allowWebSearch);
      guard();
      set(state => ({ taskRuns: state.taskRuns.map(task => task.id === id ? { ...task, status: 'succeeded', summary, updatedAt: new Date().toISOString() } : task) }));
      await persist(true); guard(); return id;
    } catch (error) {
      if (epoch === generation && get().unlocked && get().taskRuns.find(task => task.id === id)?.status !== 'succeeded') {
        const status = controller.signal.aborted ? 'cancelled' as const : 'failed' as const, stoppedAt = new Date().toISOString();
        const message = controller.signal.aborted ? '任务已取消或超时；已保存成果保留。' : error instanceof Error ? error.message : '多步骤任务失败。';
        set(state => ({ taskRuns: state.taskRuns.map(task => task.id === id ? { ...task, status, error: message, updatedAt: stoppedAt } : task),
          toolRuns: state.toolRuns.map(tool => tool.taskId === id && tool.status === 'running' ? { ...tool, status, error: message, finishedAt: stoppedAt } : tool) }));
        await persist();
      }
      throw error;
    } finally { clearTimeout(timeout); controllers.delete(token); accountRequests.delete(token); }
  },
  stageWorkflowDraft: definition => {
    if (!get().unlocked || !vault) return false;
    try {
      const draft = validateWorkflow({ ...JSON.parse(JSON.stringify(definition)), updatedAt: new Date().toISOString() }, true);
      const version = ++workflowDraftVersion;
      clearWorkflowDraftTimer();
      set({ workflowDraft: draft, workflowDraftSaving: true });
      workflowDraftTimer = setTimeout(() => {
        workflowDraftTimer = undefined;
        if (version !== workflowDraftVersion || !get().unlocked) return;
        void persist().finally(() => { if (version === workflowDraftVersion && get().unlocked) set({ workflowDraftSaving: false }); });
      }, 500);
      return true;
    } catch {
      // Keep the last valid encrypted draft while a field is temporarily incomplete.
      return false;
    }
  },
  clearWorkflowDraft: async () => {
    if (!get().unlocked || !vault) throw new Error('请先解锁本机密钥库。');
    workflowDraftVersion++;
    clearWorkflowDraftTimer();
    set({ workflowDraft: null, workflowDraftSaving: false });
    await persist(true);
  },
  saveWorkflow: async definition => {
    const epoch = generation;
    if (!get().unlocked || !vault) throw new Error('请先解锁本机密钥库。');
    const frozen = JSON.parse(JSON.stringify(definition)) as WorkflowDefinition;
    const { validateWorkflow } = await import('@/workflows/definition');
    if (epoch !== generation || !get().unlocked) throw new Error('密钥库已锁定。');
    const clean = validateWorkflow(frozen), previous = get().workflows.find(item => item.id === clean.id);
    if ((previous?.revision ?? 0) !== clean.revision) throw new Error('工作流已在其他编辑器中更新，请重新载入后修改。');
    if (!previous && get().workflows.length >= 30) throw new Error('最多保存 30 个工作流。');
    if (clean.revision >= 1000000) throw new Error('工作流修订已达上限，请另存为新工作流。');
    const saved = { ...clean, name: clean.name.trim(), revision: clean.revision + 1, updatedAt: new Date().toISOString() };
    if (get().workflowDraft?.id === saved.id) { workflowDraftVersion++; clearWorkflowDraftTimer(); }
    set(state => ({ workflows: [...state.workflows.filter(item => item.id !== saved.id), saved],
      ...(state.workflowDraft?.id === saved.id ? { workflowDraft: null, workflowDraftSaving: false } : {}) }));
    await persist(true);
    if (epoch !== generation || !get().unlocked) throw new Error('密钥库已锁定。');
    return saved;
  },
  removeWorkflow: async (id, revision) => {
    if (!get().unlocked || !vault) throw new Error('请先解锁本机密钥库。');
    if (get().workflows.find(item => item.id === id)?.revision !== revision) throw new Error('工作流已变化，请重新载入。');
    if (get().workflowDraft?.id === id) { workflowDraftVersion++; clearWorkflowDraftTimer(); }
    set(state => ({ workflows: state.workflows.filter(item => item.id !== id),
      ...(state.workflowDraft?.id === id ? { workflowDraft: null, workflowDraftSaving: false } : {}) }));
    await persist(true);
  },
  startWorkflow: async (definitionId, revision, input, profileId, allowCloud, resume) => {
    const epoch = generation;
    if (!get().unlocked || !vault) throw new Error('请先解锁本机密钥库。');
    // Snapshot caller input before imports/awaits; definitions cannot mutate a live run.
    const frozenInput = JSON.parse(JSON.stringify(input)) as WorkflowInput;
    const { prepareWorkflow, runWorkflow } = await import('@/workflows/runner');
    if (epoch !== generation || !get().unlocked) throw new Error('密钥库已锁定。');
    const source = resume ? get().taskRuns.find(task => task.id === resume.sourceTaskId) : undefined;
    if (resume && (!source || !source.workflow || !['failed', 'interrupted', 'cancelled'].includes(source.status))) {
      throw new Error('仅失败、中断或取消的工作流可以继续运行。');
    }
    const definition = resume ? source?.workflow?.definition : get().workflows.find(item => item.id === definitionId);
    if (!definition || definition.revision !== revision) throw new Error('工作流未保存或修订已变化，请保存/重新载入后运行。');
    const frozen = prepareWorkflow(definition, frozenInput);
    if (resume && source?.workflow && (source.workflow.definition.id !== frozen.definition.id || source.workflow.definition.revision !== frozen.definition.revision
      || JSON.stringify(source.workflow.input) !== JSON.stringify(frozen.input))) {
      throw new Error('续跑必须使用原工作流修订和原始输入快照。');
    }
    const completedResults = new Map<string, string>();
    const restoredCheckpoints: { step: ToolRun; artifact?: WorkArtifact }[] = [];
    let resumeNodeId = resume?.fromNodeId;
    if (resume && source) {
      const ordered = workflowOrder(frozen.definition);
      // dev.29 continuations omitted skipped checkpoints. Resolve only their
      // skipped prefix from ancestry; an actual failed checkpoint takes precedence.
      const findCheckpoint = (nodeId: string) => {
        let current: TaskRun | undefined = source;
        const seen = new Set<string>();
        while (current && !seen.has(current.id)) {
          seen.add(current.id);
          const step = get().toolRuns.find(tool => tool.taskId === current!.id && tool.workflowNodeId === nodeId);
          if (step) return step;
          const skippedBefore = ordered.findIndex(node => node.id === current!.resumeFromNodeId);
          if (!current.resumedFromTaskId || ordered.findIndex(node => node.id === nodeId) >= skippedBefore) break;
          current = get().taskRuns.find(task => task.id === current!.resumedFromTaskId);
        }
        return undefined;
      };
      const firstIncomplete = ordered.find(node => {
        const step = findCheckpoint(node.id);
        return !step || step.status !== 'succeeded' || Boolean(step.finishReason && step.finishReason !== 'stop');
      });
      resumeNodeId = resumeNodeId || firstIncomplete?.id;
      if (!resumeNodeId) throw new Error('原工作流没有可续跑的步骤。');
      const resumeIndex = ordered.findIndex(node => node.id === resumeNodeId);
      if (resumeIndex < 0) throw new Error('续跑步骤不存在于原工作流快照中。');
      for (const node of ordered.slice(0, resumeIndex)) {
        const step = findCheckpoint(node.id);
        if (!step || step.status !== 'succeeded' || Boolean(step.finishReason && step.finishReason !== 'stop') || !step.result) {
          throw new Error('续跑步骤的前置检查点不完整，无法安全跳过。');
        }
        let result = step.result;
        const restoredStep = { ...step, id: crypto.randomUUID(), warnings: [...new Set([...(step.warnings ?? []), '已恢复成功检查点，本次未重新执行。'])] };
        let restoredArtifact: WorkArtifact | undefined;
        if (step.outputArtifactId) {
          const artifact = get().artifacts.find(item => item.id === step.outputArtifactId && item.taskId === step.taskId);
          if (!artifact) throw new Error('续跑所需的前置成果已丢失。');
          restoredArtifact = { ...artifact, id: crypto.randomUUID() };
          restoredStep.outputArtifactId = restoredArtifact.id;
          const payload = JSON.parse(step.result) as Record<string, unknown>;
          restoredStep.result = JSON.stringify({ ...payload, artifact_id: restoredArtifact.id });
          result = artifact.kind === 'markdown' ? artifact.content : restoredStep.result;
        }
        restoredCheckpoints.push({ step: restoredStep, artifact: restoredArtifact });
        completedResults.set(node.id, result);
      }
    }
    const modelNodes = frozen.definition.nodes.filter(node => node.kind === 'generate_document');
    const usesModel = modelNodes.length > 0;
    const routes = new Map(modelNodes.map(node => {
      const routeId = node.profileId || profileId;
      return [node.id, { id: routeId, profile: get().profiles.find(item => item.id === routeId), secret: secrets.find(item => item.id === routeId), account: routeId === ACCOUNT_MODEL_ID }];
    }));
    const cloud = [...routes.values()].some(route => route.account || route.profile?.mode === 'relay');
    if (usesModel) {
      for (const route of routes.values()) {
        if (route.account) {
          if (!get().accountModel || !useAuthStore.getState().isAuthenticated || get().accountModel?.userId !== useAuthStore.getState().user?.id) throw new Error('当前账号模型不可用，请先检查权限。');
        } else if (!route.profile || !route.secret) throw new Error('工作流模型步骤引用了不可用的连接，请修改步骤选型或保存默认连接。');
      }
      if (cloud && !allowCloud) throw new Error('发送本次工作流材料和前置结果到云端前需要明确授权。');
    }
    if (controllers.size >= 3) throw new Error('最多同时运行 3 个模型或工作流请求。');
    if (get().taskRuns.length >= 100) throw new Error('最多保留 100 个办公任务。');
    const id = crypto.randomUUID(), token = `task:${id}`, now = new Date().toISOString(), controller = new AbortController();
    controllers.set(token, controller); if ([...routes.values()].some(route => route.account)) accountRequests.add(token);
    const guard = () => { if (controller.signal.aborted || epoch !== generation || !get().unlocked) throw new DOMException('工作流已停止或密钥库已锁定', 'AbortError'); };
    set(state => ({ taskRuns: [{ id, type: 'workflow.run', workflow: frozen, title: definition.name, profileId: usesModel ? profileId : '',
      instruction: resume ? '从已保存检查点继续运行工作流' : '手动运行已保存工作流', status: 'running', createdAt: now, updatedAt: now,
      toolRunIds: restoredCheckpoints.map(item => item.step.id), artifactIds: restoredCheckpoints.flatMap(item => item.artifact ? [item.artifact.id] : []),
      ...(source ? { resumedFromTaskId: source.id, ...(resumeNodeId ? { resumeFromNodeId: resumeNodeId } : {}) } : {}) }, ...state.taskRuns],
      toolRuns: [...state.toolRuns, ...restoredCheckpoints.map(item => ({ ...item.step, taskId: id }))],
      artifacts: [...restoredCheckpoints.flatMap(item => item.artifact ? [{ ...item.artifact, taskId: id }] : []), ...state.artifacts] }));
    const timeout = setTimeout(() => controller.abort(), 12 * 60000);
    try {
      await persist(true); guard();
      const summary = await runWorkflow(id, frozen.definition, frozen.input, controller.signal, async (document, node) => {
        guard();
        const route = routes.get(node.id);
        if (!route) throw new Error('工作流模型步骤没有可用的模型路由。');
        const round = new AbortController(), abort = () => round.abort();
        controller.signal.addEventListener('abort', abort, { once: true });
        const roundTimeout = setTimeout(abort, 120000);
        let finishReason: FinishReason = 'unknown';
        const preview = generationPreview(round.signal, () => epoch === generation && get().unlocked && !controller.signal.aborted, value => {
          if (epoch !== generation) return;
          set(state => { const generationPreviews = { ...state.generationPreviews }; if (value) generationPreviews[id] = value; else delete generationPreviews[id]; return { generationPreviews }; });
        });
        try {
          const messages = buildDocumentMessages(document), finish = (reason: FinishReason) => { finishReason = reason; };
          const result = route.account ? await completeAccountModel(messages, round.signal, preview.push, finish)
            : { content: await completeModel(route.profile!, route.secret!.apiKey, messages, round.signal, preview.push, finish), model: route.profile!.model };
          guard(); if (round.signal.aborted) throw new Error('此模型步骤已超时。');
          return { ...result, finishReason };
        } finally { preview.dispose(); clearTimeout(roundTimeout); controller.signal.removeEventListener('abort', abort); }
      }, async ({ step, artifact }) => {
        guard();
        set(state => ({ toolRuns: [...state.toolRuns.filter(item => item.id !== step.id), step], artifacts: artifact ? [artifact, ...state.artifacts] : state.artifacts,
          taskRuns: state.taskRuns.map(task => task.id === id ? { ...task, updatedAt: new Date().toISOString(),
            toolRunIds: task.toolRunIds.includes(step.id) ? task.toolRunIds : [...task.toolRunIds, step.id], artifactIds: artifact ? [...task.artifactIds, artifact.id] : task.artifactIds } : task) }));
        await persist(true); guard();
      }, { completedResults });
      guard();
      set(state => ({ taskRuns: state.taskRuns.map(task => task.id === id ? { ...task, status: 'succeeded', summary, updatedAt: new Date().toISOString() } : task) }));
      await persist(true); guard(); return id;
    } catch (error) {
      if (epoch === generation && get().unlocked && get().taskRuns.find(task => task.id === id)?.status !== 'succeeded') {
        const status = controller.signal.aborted ? 'cancelled' as const : 'failed' as const, stoppedAt = new Date().toISOString();
        const message = controller.signal.aborted ? '工作流已取消或超时；已保存成果保留。' : error instanceof Error ? error.message : '工作流失败。';
        set(state => ({ taskRuns: state.taskRuns.map(task => task.id === id ? { ...task, status, error: message, updatedAt: stoppedAt } : task),
          toolRuns: state.toolRuns.map(tool => tool.taskId === id && tool.status === 'running' ? { ...tool, status, error: message, finishedAt: stoppedAt } : tool) }));
        await persist();
      }
      throw error;
    } finally { clearTimeout(timeout); controllers.delete(token); accountRequests.delete(token); }
  },
  resumeWorkflow: async (taskId, fromNodeId, allowCloud) => {
    const source = get().taskRuns.find(task => task.id === taskId);
    if (!source?.workflow) throw new Error('找不到可续跑的工作流记录。');
    return get().startWorkflow(source.workflow.definition.id, source.workflow.definition.revision, source.workflow.input,
      source.profileId, allowCloud, { sourceTaskId: taskId, ...(fromNodeId ? { fromNodeId } : {}) });
  },
  cancelTask: (id) => { controllers.get(`task:${id}`)?.abort(); },
  startChartTask: async (input, requestId) => {
    if (!get().unlocked || !vault) throw new Error('请先解锁本机密钥库。');
    if (!/^[a-f0-9-]{36}$/i.test(requestId)) throw new Error('图表任务标识无效。');
    const id = `chart:${requestId}`, snapshot = { ...input, ...(input.valueColumns !== undefined ? { valueColumns: [...input.valueColumns] } : {}) }, epoch = generation;
    if (artifactOperations.has(id)) throw new Error('图表任务正在处理。');
    if (artifactOperations.size >= 3) throw new Error('最多同时运行 3 个本地成果操作。');
    const existing = get().taskRuns.find(task => task.id === id);
    if (existing) {
      if (JSON.stringify(existing.chartInput) !== JSON.stringify(snapshot)) throw new Error('重试内容已改变，请新建图表任务。');
      if (!existing.artifactIds.length) throw new Error('该图表任务未完成，请重新检查并创建任务。');
      const controller = new AbortController(); artifactOperations.set(id, controller);
      try { await get().retryStorage(); return id; }
      finally { if (artifactOperations.get(id) === controller) artifactOperations.delete(id); }
    }
    if (get().taskRuns.length >= 100) throw new Error('最多保留 100 个任务，请先删除不需要的记录。');
    const controller = new AbortController(); artifactOperations.set(id, controller);
    const guard = () => { if (controller.signal.aborted || epoch !== generation || !get().unlocked) throw new Error('图表任务已取消或密钥库已锁定。'); };
    let created = false;
    try {
      const { checkChart, renderChartSvg, CHART_RENDERER_VERSION } = await import('@/officeTasks/chart'); guard();
      const checked = checkChart(snapshot), now = new Date().toISOString(), checkId = crypto.randomUUID(), renderId = crypto.randomUUID();
      // Recheck after dynamic import: multiple tasks may have filled capacity.
      if (get().taskRuns.length >= 100) throw new Error('最多保留 100 个任务，请先删除不需要的记录。');
      set(state => ({ taskRuns: [{ id, type: 'chart.generate', chartInput: snapshot, title: checked.input.title, profileId: '', instruction: '本地 CSV 校验与图表生成', status: 'running', createdAt: now, updatedAt: now, artifactIds: [], toolRunIds: [checkId, renderId] }, ...state.taskRuns],
        toolRuns: [...state.toolRuns, { id: checkId, taskId: id, tool: 'chart.check', status: 'succeeded', startedAt: now, finishedAt: now, warnings: checked.warnings },
          { id: renderId, taskId: id, tool: 'chart.render', status: 'running', startedAt: now, converterVersion: CHART_RENDERER_VERSION }] }));
      created = true;
      await persist(true); guard();
      const content = renderChartSvg(checked), sha256 = await sha256Text(content); guard();
      const finishedAt = new Date().toISOString(), artifactId = crypto.randomUUID();
      const name = Array.from(checked.input.title).map(char => '<>:"/\\|?*'.includes(char) ? '_' : char).join('') + '.svg';
      const artifact: WorkArtifact = { id: artifactId, taskId: id, kind: 'svg', version: 1, name, mimeType: 'image/svg+xml', content, sha256, createdAt: finishedAt };
      set(state => ({ artifacts: [artifact, ...state.artifacts],
        taskRuns: state.taskRuns.map(task => task.id === id ? { ...task, status: 'succeeded', updatedAt: finishedAt, artifactIds: [artifactId] } : task),
        toolRuns: state.toolRuns.map(tool => tool.id === renderId ? { ...tool, status: 'succeeded', finishedAt, outputArtifactId: artifactId, outputName: name, outputSha256: sha256 } : tool) }));
      await persist(true); guard(); return id;
    } catch (error) {
      if (created && epoch === generation && get().unlocked && !get().taskRuns.find(task => task.id === id)?.artifactIds.length) {
        const finishedAt = new Date().toISOString();
        set(state => ({ taskRuns: state.taskRuns.map(task => task.id === id ? { ...task, status: 'failed', updatedAt: finishedAt, error: '本地图表生成或保存失败，请重新检查后再试。' } : task),
          toolRuns: state.toolRuns.map(tool => tool.taskId === id && tool.status === 'running' ? { ...tool, status: 'failed', finishedAt } : tool) }));
        await persist();
      }
      throw error;
    } finally { if (artifactOperations.get(id) === controller) artifactOperations.delete(id); }
  },
  retryStorage: async () => {
    const epoch = generation;
    await persist(true);
    if (epoch !== generation || !get().unlocked) throw new Error('密钥库已锁定。');
  },
  saveArtifactVersion: (sourceId, content) => appendArtifactVersion(sourceId, { kind: 'edit', content }),
  restoreArtifactVersion: (sourceId, expectedLatestId) => appendArtifactVersion(sourceId, { kind: 'restore', expectedLatestId }),
  exportArtifactDocx: async (sourceId, style = 'standard', format = {}) => {
    if (!get().unlocked || !vault) throw new Error('请先解锁本机密钥库。');
    const source = get().artifacts.find(item => item.id === sourceId);
    const task = get().taskRuns.find(item => item.id === source?.taskId);
    if (!source || !task || (['office.tools', 'workflow.run'].includes(task.type) ? task.status === 'running' : task.status !== 'succeeded')) throw new Error('源成果不存在或任务尚未完成。');
    if (source.kind !== 'markdown' || !['document.generate-markdown', 'office.tools', 'workflow.run'].includes(task.type)) throw new Error('仅 Markdown 文档支持 DOCX 导出。');
    if (artifactOperations.has(task.id)) throw new Error('此任务正在保存或导出，请稍后重试。');
    if (get().toolRuns.filter(item => item.taskId === task.id && item.tool === 'document.export-docx').length >= 100) throw new Error('每个任务最多保留 100 次 DOCX 导出记录。');
    const controller = new AbortController(), epoch = generation, toolId = crypto.randomUUID(), now = new Date().toISOString();
    artifactOperations.set(task.id, controller);
    const guard = () => { if (controller.signal.aborted || epoch !== generation || !get().unlocked) throw new Error('导出已取消或密钥库已锁定。'); };
    set(state => ({ toolRuns: [...state.toolRuns, { id: toolId, taskId: task.id, tool: 'document.export-docx', arguments: JSON.stringify({ style, format }), status: 'running', sourceArtifactId: source.id, startedAt: now }],
      taskRuns: state.taskRuns.map(item => item.id === task.id ? { ...item, toolRunIds: [...item.toolRunIds, toolId] } : item) }));
    try {
      await persist(true); guard();
      const { exportDocx } = await import('@/officeTasks/docxClient'); guard();
      const result = await exportDocx(documentExportContent(source), task.title, controller.signal, style, format); guard();
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
    if (get().taskRuns.some(task => task.resumedFromTaskId === id)) throw new Error('此运行被续跑记录引用，请先删除后续续跑记录。');
    set(state => ({ taskRuns: state.taskRuns.filter(task => task.id !== id), toolRuns: state.toolRuns.filter(tool => tool.taskId !== id),
      artifacts: state.artifacts.filter(artifact => artifact.taskId !== id) }));
    await persist(true);
  },
  answerKnowledge: async (profileId, question, sources, allowCloud, signal, onPreview, history = []) => {
    if (!get().unlocked) throw new Error('请先解锁本机密钥库。');
    const messages = buildKnowledgeMessages(question, sources, history);
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
    let finishReason: FinishReason = 'unknown';
    const onFinish = (reason: FinishReason) => { finishReason = reason; };
    const preview = generationPreview(controller.signal, () => epoch === generation && get().unlocked && controllers.get(id) === controller, value => onPreview?.(value));
    try {
      if (signal.aborted) abort();
      if (controller.signal.aborted) throw new DOMException('请求已取消', 'AbortError');
      const result = account ? await completeAccountModel(messages, controller.signal, preview.push, onFinish) : {
        content: await completeModel(profile!, secret!.apiKey, messages, controller.signal, preview.push, onFinish), model: profile!.model,
      };
      if (controller.signal.aborted || epoch !== generation) throw new DOMException('请求已取消或密钥库已锁定', 'AbortError');
      return { ...result, finishReason };
    } finally {
      preview.dispose(); clearTimeout(timeout); signal.removeEventListener('abort', abort); controllers.delete(id); accountRequests.delete(id);
    }
  },
}));

window.addEventListener("storage", (event) => {
  if ((!event.key || event.key === VAULT_STORAGE_KEY) && useWorkbenchStore.getState().unlocked) eraseMemory();
});
if (typeof BroadcastChannel !== 'undefined') {
  const vaultChanges = new BroadcastChannel(VAULT_CHANGE_CHANNEL);
  vaultChanges.addEventListener('message', event => {
    if (event.data?.key === VAULT_STORAGE_KEY && event.data?.source !== VAULT_WINDOW_ID && useWorkbenchStore.getState().unlocked) eraseMemory();
  });
}
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
