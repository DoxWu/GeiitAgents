/**
 * 文档状态管理 Store
 *
 * 作用：
 *   使用 Zustand 管理文档管理页面的状态，包括：
 *   - 文档库分支列表与当前选中分支
 *   - 文档列表与分页信息
 *   - 搜索关键词与排序状态
 *   - 文档加载/上传状态
 *   - 当前预览的文档
 *   - 文档处理状态轮询（自动更新 processing 状态的文档进度）
 *
 * 使用方式：
 *   import { useDocumentStore } from '@/store/documentStore';
 *   const { documents, loadDocuments } = useDocumentStore();
 */

import { create } from "zustand";
import * as documentApi from "@/api/document";
import type {
  DocumentResponse,
  DocumentFolder,
  DocumentStatus,
  DocumentQueryParams,
  DocumentScope,
  SortField,
  SortOrder,
  UploadDocumentParams,
  BatchOperationResponse,
} from "@/types/document";
import { POLL_INTERVAL, MAX_POLL_COUNT, USER_STORAGE_KEY } from "@/utils/constants";
import { safeStorage } from "@/utils/safeStorage";
import { getAccountServer } from "@/services/accountServer";

/** 文档 Store 状态接口 */
interface DocumentState {
  // ===== 分支状态 =====
  /** 文档库分支列表 */
  folders: DocumentFolder[];
  /** 当前选中的分支ID（null 表示全部） */
  currentFolderId: number | null;
  /** 分支加载中 */
  foldersLoading: boolean;
  /**
   * 当前文档范围（修复 Issue 8：区分公用/个人文档库）
   * - accessible: 我可访问的（自己的+公共库，默认）
   * - mine: 仅个人文档库
   * - public: 仅公共文档库
   */
  currentScope: DocumentScope;

  // ===== 文档列表状态 =====
  /** 文档列表 */
  documents: DocumentResponse[];
  /** 文档总数 */
  total: number;
  /** 当前页码 */
  page: number;
  /** 每页数量 */
  pageSize: number;
  /** 文档列表加载中 */
  loading: boolean;
  /** 错误信息 */
  error: string | null;

  // ===== 搜索与排序 =====
  /** 搜索关键词 */
  searchKeyword: string;
  /** 搜索历史（D2-03，最近 10 条，去重，持久化到 localStorage） */
  searchHistory: string[];
  /** 当前账号是否保存搜索历史 */
  searchHistoryEnabled: boolean;
  /** 排序字段 */
  sortBy: SortField;
  /** 排序方向 */
  sortOrder: SortOrder;
  /** 文档列表筛选条件 */
  documentFilters: {
    status: DocumentStatus | "";
    file_type: string;
    date_from: string;
    date_to: string;
  };

  // ===== 预览状态 =====
  /** 当前预览的文档 */
  previewDocument: DocumentResponse | null;
  /** 预览面板是否打开 */
  previewOpen: boolean;

  // ===== 多选状态 =====
  /** 已选中的文档ID集合 */
  selectedDocIds: Set<number>;
  /** 是否处于多选模式 */
  selectionMode: boolean;

  // ===== 分支操作 =====
  /** 加载分支列表 */
  loadFolders: () => Promise<void>;
  /** 创建分支 */
  createFolder: (name: string) => Promise<void>;
  /** 重命名分支 */
  renameFolder: (id: number, name: string) => Promise<void>;
  /** 删除分支 */
  deleteFolder: (id: number) => Promise<void>;
  /** 选择分支 */
  selectFolder: (id: number | null) => void;
  /** 选择文档范围（修复 Issue 8：公用/个人文档库切换） */
  selectScope: (scope: DocumentScope) => void;

  // ===== 文档操作 =====
  /** 加载文档列表 */
  loadDocuments: () => Promise<void>;
  /** 上传文档（支持 AbortSignal 取消） */
  uploadDocument: (
    params: UploadDocumentParams,
    onProgress?: (percent: number) => void,
    signal?: AbortSignal,
  ) => Promise<DocumentResponse>;
  /** 删除文档 */
  removeDocument: (id: number) => Promise<void>;
  /** 重新处理文档 */
  reprocessDocument: (id: number) => Promise<void>;
  /** 移动文档到其他分支 / 切换文档库（修复 Issue 6 + 问题3b） */
  moveDocument: (
    id: number,
    folderId: number | null | undefined,
    visibility?: "private" | "public",
  ) => Promise<void>;

  // ===== 搜索与排序 =====
  /** 设置搜索关键词（不立即加载，由组件防抖触发） */
  setSearchKeyword: (keyword: string) => void;
  /** 添加搜索关键词到历史（D2-03） */
  addSearchHistory: (keyword: string) => void;
  /** 清空搜索历史（D2-03） */
  clearSearchHistory: () => void;
  /** 开启或关闭搜索历史保存 */
  setSearchHistoryEnabled: (enabled: boolean) => void;
  /** 设置排序 */
  setSort: (field: SortField, order: SortOrder) => void;
  /** 更新筛选条件并回到第一页 */
  setDocumentFilters: (filters: Partial<DocumentState["documentFilters"]>) => void;
  /** 设置当前页码并加载文档 */
  setPage: (page: number) => void;

  // ===== 预览操作 =====
  /** 打开预览 */
  openPreview: (doc: DocumentResponse) => void;
  /** 关闭预览 */
  closePreview: () => void;

  // ===== 多选操作 =====
  /** 进入多选模式 */
  enterSelectionMode: () => void;
  /** 退出多选模式（并清空选择） */
  exitSelectionMode: () => void;
  /** 切换单个文档的选中状态 */
  toggleSelect: (docId: number) => void;
  /** 全选当前页文档 */
  selectAll: () => void;
  /** 清空选择 */
  clearSelection: () => void;
  /** 批量删除选中的文档 */
  batchDelete: () => Promise<BatchOperationResponse>;
  /** 批量移动选中的文档到目标分支 / 批量切换文档库（修复问题3b） */
  batchMove: (
    folderId: number | null | undefined,
    visibility?: "private" | "public",
  ) => Promise<BatchOperationResponse>;

  // ===== 轮询管理 =====
  /** 检查并启动处理中文档的状态轮询 */
  startPollingIfNeeded: () => void;
  /** 停止所有轮询 */
  stopAllPolling: () => void;

  /** 清除错误 */
  clearError: () => void;
  /** 按当前账号和服务器重新载入搜索历史 */
  loadSearchHistoryForCurrentAccount: () => void;

  /**
   * 重置 Store 到初始状态
   *
   * 作用：
   *   在用户登出/切换账户时调用，清除所有用户特定的文档数据（分支、文档列表、预览、多选等），
   *   防止前一个用户的数据残留到下一个用户的会话中。
   *   搜索历史按账号和服务器隔离；重置时清空内存态，登录后再载入当前账号历史。
   */
  reset: () => void;
}

/**
 * 轮询管理器（模块级，非 React 状态）
 *
 * 存储每个文档ID对应的轮询定时器和轮询次数，
 * 避免在 Store 状态中存储定时器引用。
 */
const pollingManager: Map<
  number,
  { timer: ReturnType<typeof setInterval>; count: number }
> = new Map();

/**
 * 启动单个文档的状态轮询
 *
 * 按文档ID查询任务状态（GET /documents/{docId}/task-status），
 * 轮询 Celery 任务进度直到终态（SUCCESS/FAILURE）。
 *
 * @param docId - 文档ID
 * @param onUpdate - 状态更新回调
 */
function startDocumentPoll(
  docId: number,
  onUpdate: (status: string, progress: number) => void,
): void {
  // 如果已在轮询，不重复启动
  if (pollingManager.has(docId)) return;

  let count = 0;

  const poll = async () => {
    count++;
    // 超过最大轮询次数，停止轮询
    if (count > MAX_POLL_COUNT) {
      stopDocumentPoll(docId);
      return;
    }

    try {
      const taskStatus = await documentApi.getTaskStatus(docId);

      // 更新文档状态
      onUpdate(taskStatus.status, taskStatus.progress);

      // 终态：停止轮询
      if (taskStatus.status === "SUCCESS" || taskStatus.status === "FAILURE") {
        stopDocumentPoll(docId);
      }
    } catch {
      // 轮询失败（网络错误等），停止该文档的轮询
      stopDocumentPoll(docId);
    }
  };

  // 立即执行一次，然后按间隔轮询
  poll();
  const timer = setInterval(poll, POLL_INTERVAL);
  pollingManager.set(docId, { timer, count });
}

/**
 * 停止单个文档的轮询
 * @param docId - 文档ID
 */
function stopDocumentPoll(docId: number): void {
  const entry = pollingManager.get(docId);
  if (entry) {
    clearInterval(entry.timer);
    pollingManager.delete(docId);
  }
}

/** 停止所有轮询 */
function stopAllDocumentPolls(): void {
  pollingManager.forEach((entry) => clearInterval(entry.timer));
  pollingManager.clear();
}

/** 默认排序：创建时间降序（最新优先） */
const DEFAULT_SORT_FIELD: SortField = "created_at";
const DEFAULT_SORT_ORDER: SortOrder = "desc";

/** D2-03 搜索历史：localStorage 存储键名 */
const SEARCH_HISTORY_KEY = "geiit-search-history";
const SEARCH_HISTORY_PREFIX = "geiit-search-history:v2:";
const SEARCH_HISTORY_ENABLED_PREFIX = "geiit-search-history-enabled:v1:";
/** D2-03 搜索历史：最大保存条数 */
const MAX_HISTORY_ITEMS = 10;
let latestDocumentListRequest = 0;

function currentSearchHistoryKey(): string {
  let userId = "anonymous";
  try {
    const user = JSON.parse(safeStorage.getItem(USER_STORAGE_KEY) || "null");
    if (user?.id !== undefined && user?.id !== null) userId = String(user.id);
  } catch {
    // Invalid or unavailable identity uses the isolated anonymous namespace.
  }
  return `${SEARCH_HISTORY_PREFIX}${encodeURIComponent(getAccountServer())}:${encodeURIComponent(userId)}`;
}

function currentSearchHistoryEnabledKey(): string {
  return SEARCH_HISTORY_ENABLED_PREFIX + currentSearchHistoryKey().slice(SEARCH_HISTORY_PREFIX.length);
}

function loadSearchHistoryEnabled(): boolean {
  try {
    return safeStorage.getItem(currentSearchHistoryEnabledKey()) !== "false";
  } catch {
    return true;
  }
}

/**
 * 从 localStorage 加载搜索历史（D2-03）
 *
 * 作用：
 *   在 store 初始化时读取已保存的搜索历史记录。
 *
 * @returns 搜索历史数组，无记录时返回空数组
 */
function loadSearchHistory(): string[] {
  try {
    // The previous shared key could expose one account's searches to another.
    safeStorage.removeItem(SEARCH_HISTORY_KEY);
    const raw = safeStorage.getItem(currentSearchHistoryKey());
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0 && item.length <= 200))]
      .slice(0, MAX_HISTORY_ITEMS);
  } catch {
    return [];
  }
}

/**
 * 保存搜索历史到 localStorage（D2-03）
 *
 * @param history - 搜索历史数组
 */
function saveSearchHistory(history: string[]): void {
  try {
    const key = currentSearchHistoryKey();
    if (history.length) safeStorage.setItem(key, JSON.stringify(history));
    else safeStorage.removeItem(key);
  } catch {
    // localStorage 写入失败（如隐私模式），忽略
  }
}

/** 文档 Store */
export const useDocumentStore = create<DocumentState>((set, get) => ({
  // ===== 初始状态 =====
  folders: [],
  currentFolderId: null,
  foldersLoading: false,
  currentScope: "accessible",

  documents: [],
  total: 0,
  page: 1,
  pageSize: 20,
  loading: false,
  error: null,

  searchKeyword: "",
  searchHistory: loadSearchHistory(),
  searchHistoryEnabled: loadSearchHistoryEnabled(),
  sortBy: DEFAULT_SORT_FIELD,
  sortOrder: DEFAULT_SORT_ORDER,
  documentFilters: { status: "", file_type: "", date_from: "", date_to: "" },

  previewDocument: null,
  previewOpen: false,

  // 多选状态初始值
  selectedDocIds: new Set<number>(),
  selectionMode: false,

  // ===== 分支操作 =====
  loadFolders: async () => {
    set({ foldersLoading: true });
    try {
      const response = await documentApi.getFolders();
      // 修复问题4：防御性检查 — 如果 API 返回空列表但本地已有分支数据，
      // 不覆盖本地数据，避免因网络抖动或后端临时异常导致分支"莫名消失"。
      // 仅在本地无分支数据时接受空响应（反映用户确实没有分支的真实状态）。
      const currentFolders = get().folders;
      if (
        (!response.items || response.items.length === 0) &&
        currentFolders.length > 0
      ) {
        set({ foldersLoading: false });
        return;
      }
      set({ folders: response.items || [], foldersLoading: false });
    } catch (err) {
      // 修复问题三：输出错误到控制台，便于排查 loadFolders 静默失败问题。
      // 原实现仅设置 error 到 store，但 DocumentsPage 未解构 error 字段，
      // 导致用户看不到加载失败信息，分支列表"莫名消失"。
      console.error("[loadFolders] 加载分支失败:", err);
      set({
        foldersLoading: false,
        error: err instanceof Error ? err.message : "加载分支失败",
      });
    }
  },

  createFolder: async (name: string) => {
    try {
      const folder = await documentApi.createFolder({ name });
      set((state) => ({ folders: [...state.folders, folder] }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "创建分支失败" });
      throw err;
    }
  },

  renameFolder: async (id: number, name: string) => {
    try {
      const updated = await documentApi.updateFolder(id, { name });
      set((state) => ({
        folders: state.folders.map((f) => (f.id === id ? updated : f)),
      }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "重命名失败" });
      throw err;
    }
  },

  deleteFolder: async (id: number) => {
    try {
      await documentApi.deleteFolder(id);
      set((state) => ({
        folders: state.folders.filter((f) => f.id !== id),
        currentFolderId:
          state.currentFolderId === id ? null : state.currentFolderId,
      }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "删除分支失败" });
      throw err;
    }
  },

  selectFolder: (id: number | null) => {
    // 修复 Issue 8：选择分支时重置范围为 accessible，避免与 scope 冲突
    set({ currentFolderId: id, currentScope: "accessible", page: 1 });
    get().loadDocuments();
  },

  selectScope: (scope: DocumentScope) => {
    // 修复 Issue 8：切换文档范围时清除分支选择，避免冲突
    set({ currentScope: scope, currentFolderId: null, page: 1 });
    get().loadDocuments();
  },

  // ===== 文档操作 =====
  loadDocuments: async () => {
    const requestId = ++latestDocumentListRequest;
    const state = get();
    set({ loading: true, error: null });
    try {
      const params: DocumentQueryParams = {
        page: state.page,
        page_size: state.pageSize,
        search: state.searchKeyword || undefined,
        status: state.documentFilters.status || undefined,
        file_type: state.documentFilters.file_type || undefined,
        date_from: state.documentFilters.date_from || undefined,
        date_to: state.documentFilters.date_to || undefined,
        sort_by: state.sortBy,
        sort_order: state.sortOrder,
        folder_id: state.currentFolderId ?? undefined,
        // 修复 Issue 8：传递 scope 参数，实现公用/个人文档库切换
        scope: state.currentScope,
      };
      const response = await documentApi.getDocuments(params);
      if (requestId !== latestDocumentListRequest) return;
      set({
        documents: response.items,
        total: response.total,
        loading: false,
      });
      // 加载完成后，检查是否需要启动轮询
      get().startPollingIfNeeded();
    } catch (err) {
      if (requestId !== latestDocumentListRequest) return;
      set({
        loading: false,
        error: err instanceof Error ? err.message : "加载文档失败",
      });
    }
  },

  uploadDocument: async (params, onProgress, signal) => {
    try {
      const doc = await documentApi.uploadDocument(params, onProgress, signal);
      // 上传成功后重新加载列表
      await get().loadDocuments();
      return doc;
    } catch (err) {
      // 如果是取消操作（AbortError），不设置错误状态
      // 注意：DOMException 在部分环境中不是 Error 实例，需通过 name 判断
      if (err && typeof err === "object" && err.name === "AbortError") {
        throw err;
      }
      set({ error: err instanceof Error ? err.message : "上传失败" });
      throw err;
    }
  },

  removeDocument: async (id: number) => {
    try {
      await documentApi.deleteDocument(id);
      // 停止该文档的轮询（如有）
      stopDocumentPoll(id);
      set((state) => ({
        documents: state.documents.filter((d) => d.id !== id),
        total: state.total - 1,
        previewDocument:
          state.previewDocument?.id === id ? null : state.previewDocument,
        previewOpen:
          state.previewDocument?.id === id ? false : state.previewOpen,
      }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "删除失败" });
      throw err;
    }
  },

  reprocessDocument: async (id: number) => {
    try {
      await documentApi.reprocessDocument(id);
      await get().loadDocuments();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "重新处理失败" });
      throw err;
    }
  },

  moveDocument: async (id, folderId, visibility) => {
    try {
      await documentApi.moveDocument(id, folderId, visibility);
      // 移动后重新加载文档列表，反映新的分支归属
      await get().loadDocuments();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "移动文档失败" });
      throw err;
    }
  },

  // ===== 搜索与排序 =====
  setSearchKeyword: (keyword: string) => {
    latestDocumentListRequest += 1;
    set({ searchKeyword: keyword, page: 1 });
  },

  addSearchHistory: (keyword: string) => {
    const trimmed = keyword.trim();
    if (!get().searchHistoryEnabled || !trimmed || trimmed.length > 200) return;
    // 去重后放到最前，保留最多 MAX_HISTORY_ITEMS 条
    const current = get().searchHistory;
    const filtered = current.filter((item) => item !== trimmed);
    const updated = [trimmed, ...filtered].slice(0, MAX_HISTORY_ITEMS);
    saveSearchHistory(updated);
    set({ searchHistory: updated });
  },

  clearSearchHistory: () => {
    saveSearchHistory([]);
    set({ searchHistory: [] });
  },

  setSearchHistoryEnabled: (enabled) => {
    try {
      safeStorage.setItem(currentSearchHistoryEnabledKey(), String(enabled));
    } catch {
      // Continue with the in-memory preference if browser storage is unavailable.
    }
    if (!enabled) saveSearchHistory([]);
    set({ searchHistoryEnabled: enabled, searchHistory: enabled ? get().searchHistory : [] });
  },

  setSort: (field: SortField, order: SortOrder) => {
    latestDocumentListRequest += 1;
    set({ sortBy: field, sortOrder: order, page: 1 });
    get().loadDocuments();
  },

  setDocumentFilters: (filters) => {
    latestDocumentListRequest += 1;
    set((state) => ({
      documentFilters: { ...state.documentFilters, ...filters },
      page: 1,
    }));
    get().loadDocuments();
  },

  setPage: (page: number) => {
    latestDocumentListRequest += 1;
    set({ page });
    get().loadDocuments();
  },

  // ===== 预览操作 =====
  openPreview: (doc: DocumentResponse) => {
    set({ previewDocument: doc, previewOpen: true });
  },

  closePreview: () => {
    set({ previewOpen: false, previewDocument: null });
  },

  // ===== 多选操作 =====
  enterSelectionMode: () => {
    set({ selectionMode: true });
  },

  exitSelectionMode: () => {
    set({ selectionMode: false, selectedDocIds: new Set<number>() });
  },

  toggleSelect: (docId: number) => {
    set((state) => {
      const newSet = new Set(state.selectedDocIds);
      if (newSet.has(docId)) {
        newSet.delete(docId);
      } else {
        newSet.add(docId);
      }
      // 自动进入多选模式（首次选中时）
      return { selectedDocIds: newSet, selectionMode: true };
    });
  },

  selectAll: () => {
    const { documents } = get();
    const newSet = new Set<number>(documents.map((d) => d.id));
    set({ selectedDocIds: newSet, selectionMode: true });
  },

  clearSelection: () => {
    set({ selectedDocIds: new Set<number>() });
  },

  batchDelete: async () => {
    const { selectedDocIds } = get();
    const ids = Array.from(selectedDocIds);
    if (ids.length === 0) {
      throw new Error("未选中任何文档");
    }
    const result = await documentApi.batchDeleteDocuments(ids);
    // 清空选择并重新加载列表
    set({ selectedDocIds: new Set<number>(), selectionMode: false });
    await get().loadDocuments();
    return result;
  },

  batchMove: async (folderId, visibility) => {
    const { selectedDocIds } = get();
    const ids = Array.from(selectedDocIds);
    if (ids.length === 0) {
      throw new Error("未选中任何文档");
    }
    const result = await documentApi.batchMoveDocuments(ids, folderId, visibility);
    // 清空选择并重新加载列表
    set({ selectedDocIds: new Set<number>(), selectionMode: false });
    await get().loadDocuments();
    return result;
  },

  // ===== 轮询管理 =====
  startPollingIfNeeded: () => {
    const { documents } = get();

    // 找出所有处理中的文档（有 task_id）
    const processingDocs = documents.filter(
      (d) =>
        (d.status === "processing" || d.status === "pending") && d.task_id,
    );

    for (const doc of processingDocs) {
      // 尚未在轮询的文档才启动
      if (!pollingManager.has(doc.id) && doc.task_id) {
        startDocumentPoll(doc.id, (status, progress) => {
          // 将 Celery 任务状态映射为文档状态
          let docStatus: DocumentResponse["status"] = doc.status;
          if (status === "SUCCESS") {
            docStatus = "completed";
          } else if (status === "FAILURE") {
            docStatus = "failed";
          }

          // 更新 store 中该文档的状态和进度
          set((state) => ({
            documents: state.documents.map((d) =>
              d.id === doc.id
                ? {
                    ...d,
                    status: docStatus,
                    processing_progress: progress,
                    // 修复 Issue 5：不再把 processing_step 覆盖为"处理中"，
                    // 保留后端返回的具体步骤（parsing/cleaning/chunking 等）
                    processing_step: d.processing_step,
                  }
                : d,
            ),
            // 同步更新预览中的文档（如正在预览）
            previewDocument:
              state.previewDocument?.id === doc.id
                ? {
                    ...state.previewDocument,
                    status: docStatus,
                    processing_progress: progress,
                  }
                : state.previewDocument,
          }));

          // 如果任务完成，重新加载文档列表以获取最终数据
          if (status === "SUCCESS" || status === "FAILURE") {
            get().loadDocuments();
          }
        });
      }
    }

    // 停止已不在列表中或已完成的文档轮询
    const activeIds = new Set(processingDocs.map((d) => d.id));
    pollingManager.forEach((_, docId) => {
      if (!activeIds.has(docId)) {
        stopDocumentPoll(docId);
      }
    });
  },

  stopAllPolling: () => {
    stopAllDocumentPolls();
  },

  clearError: () => set({ error: null }),

  loadSearchHistoryForCurrentAccount: () => {
    const searchHistoryEnabled = loadSearchHistoryEnabled();
    set({ searchHistoryEnabled, searchHistory: searchHistoryEnabled ? loadSearchHistory() : [] });
  },

  reset: () => {
    latestDocumentListRequest += 1;
    // 停止所有轮询，避免轮询回调写入已重置的状态
    stopAllDocumentPolls();
    set({
      // 分支状态
      folders: [],
      currentFolderId: null,
      foldersLoading: false,
      currentScope: "accessible",
      // 文档列表
      documents: [],
      total: 0,
      page: 1,
      loading: false,
      error: null,
      // 搜索与排序
      searchKeyword: "",
      searchHistory: [],
      searchHistoryEnabled: true,
      sortBy: DEFAULT_SORT_FIELD,
      sortOrder: DEFAULT_SORT_ORDER,
      documentFilters: { status: "", file_type: "", date_from: "", date_to: "" },
      // 预览
      previewDocument: null,
      previewOpen: false,
      // 多选
      selectedDocIds: new Set<number>(),
      selectionMode: false,
    });
  },
}));
