/**
 * documentStore 单元测试
 *
 * 覆盖范围：
 *   - loadDocuments：加载文档列表
 *   - setSearchKeyword：设置搜索关键词
 *   - setSort：设置排序
 *   - selectFolder：选择分支
 *   - openPreview / closePreview：预览状态
 *   - clearError：清除错误
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock document API
const { mockDocumentApi } = vi.hoisted(() => ({
  mockDocumentApi: {
    getDocuments: vi.fn(),
    getDocumentDetail: vi.fn(),
    deleteDocument: vi.fn(),
    reprocessDocument: vi.fn(),
    uploadDocument: vi.fn(),
    getFolders: vi.fn(),
    createFolder: vi.fn(),
    updateFolder: vi.fn(),
    deleteFolder: vi.fn(),
    getTaskStatus: vi.fn(),
  },
}));

vi.mock("@/api/document", () => mockDocumentApi);

import { useDocumentStore } from "@/store/documentStore";
import type { DocumentResponse, DocumentFolder, DocumentListResponse } from "@/types/document";

/** 创建测试用文档数据 */
function createMockDocument(overrides?: Partial<DocumentResponse>): DocumentResponse {
  return {
    id: 1,
    title: "测试文档",
    file_name: "test.pdf",
    file_type: ".pdf",
    file_size: 1024,
    status: "completed",
    visibility: "private",
    folder_id: null,
    processing_step: null,
    processing_progress: 100,
    quality_score: 85,
    quality_issues: null,
    chunk_count: 5,
    total_tokens: 300,
    task_id: null,
    error_message: null,
    created_at: "2026-07-10T00:00:00Z",
    updated_at: "2026-07-10T00:00:00Z",
    ...overrides,
  };
}

/** 创建测试用分支数据 */
function createMockFolder(overrides?: Partial<DocumentFolder>): DocumentFolder {
  return {
    id: 1,
    name: "默认分支",
    document_count: 0,
    created_at: "2026-07-10T00:00:00Z",
    updated_at: "2026-07-10T00:00:00Z",
    ...overrides,
  };
}

describe("documentStore", () => {
  beforeEach(() => {
    // 停止所有轮询（清理上一轮测试残留的定时器）
    useDocumentStore.getState().stopAllPolling();

    // 重置 store
    useDocumentStore.setState({
      folders: [],
      currentFolderId: null,
      foldersLoading: false,
      documents: [],
      total: 0,
      page: 1,
      pageSize: 20,
      loading: false,
      error: null,
      searchKeyword: "",
      sortBy: "created_at",
      sortOrder: "desc",
      searchHistory: [],
      previewDocument: null,
      previewOpen: false,
    });

    // 重置 mocks
    vi.clearAllMocks();
  });

  afterEach(() => {
    // 确保每个测试结束后停止所有轮询
    useDocumentStore.getState().stopAllPolling();
  });

  describe("loadDocuments", () => {
    it("成功加载文档列表", async () => {
      const mockDocs = [createMockDocument(), createMockDocument({ id: 2 })];
      mockDocumentApi.getDocuments.mockResolvedValueOnce({
        items: mockDocs,
        total: 2,
        page: 1,
        page_size: 20,
      });

      const { loadDocuments } = useDocumentStore.getState();
      await loadDocuments();

      const state = useDocumentStore.getState();
      expect(state.documents).toHaveLength(2);
      expect(state.total).toBe(2);
      expect(state.loading).toBe(false);
      expect(state.error).toBeNull();
    });

    it("加载失败时设置 error 状态", async () => {
      mockDocumentApi.getDocuments.mockRejectedValueOnce(new Error("网络错误"));

      const { loadDocuments } = useDocumentStore.getState();
      await loadDocuments();

      const state = useDocumentStore.getState();
      expect(state.loading).toBe(false);
      expect(state.error).toBe("网络错误");
      expect(state.documents).toHaveLength(0);
    });

    it("加载时设置 loading 状态", async () => {
      mockDocumentApi.getDocuments.mockResolvedValueOnce({
        items: [],
        total: 0,
        page: 1,
        page_size: 20,
      });

      const { loadDocuments } = useDocumentStore.getState();
      const promise = loadDocuments();

      // 加载中
      expect(useDocumentStore.getState().loading).toBe(true);

      await promise;

      // 加载完成
      expect(useDocumentStore.getState().loading).toBe(false);
    });

    it("旧请求晚返回时不覆盖较新的搜索结果", async () => {
      let resolveOld!: (value: DocumentListResponse) => void;
      let resolveNew!: (value: DocumentListResponse) => void;
      mockDocumentApi.getDocuments
        .mockImplementationOnce(() => new Promise<DocumentListResponse>((resolve) => { resolveOld = resolve; }))
        .mockImplementationOnce(() => new Promise<DocumentListResponse>((resolve) => { resolveNew = resolve; }));

      useDocumentStore.getState().setSearchKeyword("旧查询");
      const oldRequest = useDocumentStore.getState().loadDocuments();
      useDocumentStore.getState().setSearchKeyword("新查询");
      const newRequest = useDocumentStore.getState().loadDocuments();
      resolveNew({ items: [createMockDocument({ id: 2 })], total: 1, page: 1, page_size: 20 });
      await newRequest;
      resolveOld({ items: [createMockDocument({ id: 1 })], total: 1, page: 1, page_size: 20 });
      await oldRequest;

      expect(useDocumentStore.getState().documents.map((document) => document.id)).toEqual([2]);
      expect(useDocumentStore.getState().loading).toBe(false);
    });
  });

  describe("setSearchKeyword", () => {
    it("设置搜索关键词", () => {
      const { setSearchKeyword } = useDocumentStore.getState();
      setSearchKeyword("测试关键词");
      expect(useDocumentStore.getState().searchKeyword).toBe("测试关键词");
    });

    it("清空搜索关键词", () => {
      const { setSearchKeyword } = useDocumentStore.getState();
      setSearchKeyword("关键词");
      setSearchKeyword("");
      expect(useDocumentStore.getState().searchKeyword).toBe("");
    });
  });

  describe("search history isolation", () => {
    it("keeps history separate by user and account server", async () => {
      const { safeStorage } = await import("@/utils/safeStorage");
      const { USER_STORAGE_KEY } = await import("@/utils/constants");
      const { getAccountServer, setAccountServer } = await import("@/services/accountServer");
      const originalServer = getAccountServer();
      try {
        setAccountServer("https://search-a.example");
        safeStorage.setItem(USER_STORAGE_KEY, JSON.stringify({ id: 1 }));
        useDocumentStore.getState().addSearchHistory("alpha private query");

        safeStorage.setItem(USER_STORAGE_KEY, JSON.stringify({ id: 2 }));
        useDocumentStore.getState().reset();
        useDocumentStore.getState().loadSearchHistoryForCurrentAccount();
        expect(useDocumentStore.getState().searchHistory).toEqual([]);

        safeStorage.setItem(USER_STORAGE_KEY, JSON.stringify({ id: 1 }));
        useDocumentStore.getState().loadSearchHistoryForCurrentAccount();
        expect(useDocumentStore.getState().searchHistory).toEqual(["alpha private query"]);

        setAccountServer("https://search-b.example");
        safeStorage.setItem(USER_STORAGE_KEY, JSON.stringify({ id: 1 }));
        useDocumentStore.getState().loadSearchHistoryForCurrentAccount();
        expect(useDocumentStore.getState().searchHistory).toEqual([]);
      } finally {
        setAccountServer(originalServer);
        safeStorage.removeItem(USER_STORAGE_KEY);
        useDocumentStore.getState().reset();
      }
    });
  });

  describe("setSort", () => {
    it("设置排序字段和方向", () => {
      const { setSort } = useDocumentStore.getState();
      setSort("file_name", "asc");
      expect(useDocumentStore.getState().sortBy).toBe("file_name");
      expect(useDocumentStore.getState().sortOrder).toBe("asc");
    });

    it("切换排序方向", () => {
      const { setSort } = useDocumentStore.getState();
      setSort("created_at", "asc");
      setSort("created_at", "desc");
      expect(useDocumentStore.getState().sortOrder).toBe("desc");
    });
  });

  describe("selectFolder", () => {
    it("选择分支时更新 currentFolderId", () => {
      const { selectFolder } = useDocumentStore.getState();
      selectFolder(5);
      expect(useDocumentStore.getState().currentFolderId).toBe(5);
    });

    it("选择 null 表示全部文档", () => {
      const { selectFolder } = useDocumentStore.getState();
      selectFolder(5);
      selectFolder(null);
      expect(useDocumentStore.getState().currentFolderId).toBeNull();
    });
  });

  describe("openPreview / closePreview", () => {
    it("openPreview 设置预览文档和打开状态", () => {
      const doc = createMockDocument();
      const { openPreview } = useDocumentStore.getState();
      openPreview(doc);

      const state = useDocumentStore.getState();
      expect(state.previewOpen).toBe(true);
      expect(state.previewDocument).toBe(doc);
    });

    it("closePreview 清除预览状态", () => {
      const doc = createMockDocument();
      const { openPreview, closePreview } = useDocumentStore.getState();
      openPreview(doc);
      closePreview();

      const state = useDocumentStore.getState();
      expect(state.previewOpen).toBe(false);
      expect(state.previewDocument).toBeNull();
    });
  });

  describe("clearError", () => {
    it("清除错误状态", () => {
      useDocumentStore.setState({ error: "测试错误" });
      const { clearError } = useDocumentStore.getState();
      clearError();
      expect(useDocumentStore.getState().error).toBeNull();
    });
  });

  describe("loadFolders", () => {
    it("成功加载分支列表", async () => {
      const mockFolders = [createMockFolder(), createMockFolder({ id: 2, name: "工作文档" })];
      mockDocumentApi.getFolders.mockResolvedValueOnce({
        items: mockFolders,
        total: 2,
      });

      const { loadFolders } = useDocumentStore.getState();
      await loadFolders();

      const state = useDocumentStore.getState();
      expect(state.folders).toHaveLength(2);
      expect(state.foldersLoading).toBe(false);
    });

    it("加载失败时不断增分支", async () => {
      mockDocumentApi.getFolders.mockRejectedValueOnce(new Error("加载失败"));

      const { loadFolders } = useDocumentStore.getState();
      await loadFolders();

      const state = useDocumentStore.getState();
      expect(state.folders).toHaveLength(0);
      expect(state.foldersLoading).toBe(false);
    });
  });

  describe("createFolder", () => {
    it("成功创建分支后添加到列表", async () => {
      const existing = createMockFolder();
      useDocumentStore.setState({ folders: [existing] });

      const newFolder = createMockFolder({ id: 2, name: "新分支" });
      mockDocumentApi.createFolder.mockResolvedValueOnce(newFolder);

      const { createFolder } = useDocumentStore.getState();
      await createFolder("新分支");

      const state = useDocumentStore.getState();
      expect(state.folders).toHaveLength(2);
      expect(state.folders.find((f) => f.name === "新分支")).toBeTruthy();
    });
  });

  describe("removeDocument", () => {
    it("删除文档后从列表移除", async () => {
      const doc1 = createMockDocument({ id: 1 });
      const doc2 = createMockDocument({ id: 2 });
      useDocumentStore.setState({ documents: [doc1, doc2], total: 2 });

      mockDocumentApi.deleteDocument.mockResolvedValueOnce(undefined);

      const { removeDocument } = useDocumentStore.getState();
      await removeDocument(1);

      const state = useDocumentStore.getState();
      expect(state.documents).toHaveLength(1);
      expect(state.documents[0].id).toBe(2);
      expect(state.total).toBe(1);
    });

    it("删除正在预览的文档时清除预览状态", async () => {
      const doc = createMockDocument({ id: 1 });
      useDocumentStore.setState({
        documents: [doc],
        total: 1,
        previewDocument: doc,
        previewOpen: true,
      });

      mockDocumentApi.deleteDocument.mockResolvedValueOnce(undefined);

      const { removeDocument } = useDocumentStore.getState();
      await removeDocument(1);

      const state = useDocumentStore.getState();
      expect(state.documents).toHaveLength(0);
      expect(state.previewDocument).toBeNull();
      expect(state.previewOpen).toBe(false);
    });

    it("删除非预览文档时保留预览状态", async () => {
      const doc1 = createMockDocument({ id: 1 });
      const doc2 = createMockDocument({ id: 2 });
      useDocumentStore.setState({
        documents: [doc1, doc2],
        total: 2,
        previewDocument: doc1,
        previewOpen: true,
      });

      mockDocumentApi.deleteDocument.mockResolvedValueOnce(undefined);

      const { removeDocument } = useDocumentStore.getState();
      await removeDocument(2);

      const state = useDocumentStore.getState();
      expect(state.documents).toHaveLength(1);
      expect(state.previewDocument).toEqual(doc1);
      expect(state.previewOpen).toBe(true);
    });

    it("删除失败时设置 error 并抛出", async () => {
      const doc = createMockDocument({ id: 1 });
      useDocumentStore.setState({ documents: [doc], total: 1 });

      mockDocumentApi.deleteDocument.mockRejectedValueOnce(new Error("删除失败"));

      const { removeDocument } = useDocumentStore.getState();
      await expect(removeDocument(1)).rejects.toThrow("删除失败");

      expect(useDocumentStore.getState().error).toBe("删除失败");
    });
  });

  describe("uploadDocument", () => {
    it("成功上传后重新加载文档列表", async () => {
      const mockDoc = createMockDocument({ id: 10 });
      mockDocumentApi.uploadDocument.mockResolvedValueOnce(mockDoc);
      mockDocumentApi.getDocuments.mockResolvedValueOnce({
        items: [mockDoc],
        total: 1,
        page: 1,
        page_size: 20,
      });

      const { uploadDocument } = useDocumentStore.getState();
      const result = await uploadDocument({
        file: new File(["content"], "test.pdf"),
      });

      expect(result).toEqual(mockDoc);
      expect(mockDocumentApi.uploadDocument).toHaveBeenCalledOnce();
      expect(mockDocumentApi.getDocuments).toHaveBeenCalledOnce();
    });

    it("AbortError（取消上传）不设置 error 状态", async () => {
      const abortError = new DOMException("上传已取消", "AbortError");
      mockDocumentApi.uploadDocument.mockRejectedValueOnce(abortError);

      const { uploadDocument } = useDocumentStore.getState();
      await expect(
        uploadDocument({ file: new File(["content"], "test.pdf") }),
      ).rejects.toMatchObject({ name: "AbortError" });

      // 取消操作不应设置 error
      expect(useDocumentStore.getState().error).toBeNull();
    });

    it("普通错误设置 error 状态并抛出", async () => {
      mockDocumentApi.uploadDocument.mockRejectedValueOnce(new Error("上传失败"));

      const { uploadDocument } = useDocumentStore.getState();
      await expect(
        uploadDocument({ file: new File(["content"], "test.pdf") }),
      ).rejects.toThrow("上传失败");

      expect(useDocumentStore.getState().error).toBe("上传失败");
    });
  });

  describe("reprocessDocument", () => {
    it("成功重新处理后重新加载列表", async () => {
      mockDocumentApi.reprocessDocument.mockResolvedValueOnce({
        task_id: "task-1",
      });
      mockDocumentApi.getDocuments.mockResolvedValueOnce({
        items: [],
        total: 0,
        page: 1,
        page_size: 20,
      });

      const { reprocessDocument } = useDocumentStore.getState();
      await reprocessDocument(1);

      expect(mockDocumentApi.reprocessDocument).toHaveBeenCalledWith(1);
      expect(mockDocumentApi.getDocuments).toHaveBeenCalledOnce();
    });

    it("失败时设置 error 并抛出", async () => {
      mockDocumentApi.reprocessDocument.mockRejectedValueOnce(
        new Error("重新处理失败"),
      );

      const { reprocessDocument } = useDocumentStore.getState();
      await expect(reprocessDocument(1)).rejects.toThrow("重新处理失败");

      expect(useDocumentStore.getState().error).toBe("重新处理失败");
    });
  });

  describe("setPage", () => {
    it("设置页码并加载文档", async () => {
      mockDocumentApi.getDocuments.mockResolvedValueOnce({
        items: [],
        total: 0,
        page: 2,
        page_size: 20,
      });

      const { setPage } = useDocumentStore.getState();
      setPage(2);

      expect(useDocumentStore.getState().page).toBe(2);

      // 等待 loadDocuments 完成
      await vi.waitFor(() => {
        expect(useDocumentStore.getState().loading).toBe(false);
      });
    });
  });

  describe("createFolder - 错误路径", () => {
    it("创建失败时设置 error 并抛出", async () => {
      mockDocumentApi.createFolder.mockRejectedValueOnce(
        new Error("创建分支失败"),
      );

      const { createFolder } = useDocumentStore.getState();
      await expect(createFolder("新分支")).rejects.toThrow("创建分支失败");

      expect(useDocumentStore.getState().error).toBe("创建分支失败");
    });
  });

  describe("renameFolder", () => {
    it("成功重命名分支", async () => {
      const folder = createMockFolder({ id: 1, name: "旧名称" });
      useDocumentStore.setState({ folders: [folder] });
      const updated = { ...folder, name: "新名称" };
      mockDocumentApi.updateFolder.mockResolvedValueOnce(updated);

      const { renameFolder } = useDocumentStore.getState();
      await renameFolder(1, "新名称");

      expect(useDocumentStore.getState().folders[0].name).toBe("新名称");
    });

    it("重命名失败时设置 error 并抛出", async () => {
      const folder = createMockFolder({ id: 1, name: "旧名称" });
      useDocumentStore.setState({ folders: [folder] });
      mockDocumentApi.updateFolder.mockRejectedValueOnce(
        new Error("重命名失败"),
      );

      const { renameFolder } = useDocumentStore.getState();
      await expect(renameFolder(1, "新名称")).rejects.toThrow("重命名失败");

      expect(useDocumentStore.getState().error).toBe("重命名失败");
    });
  });

  describe("deleteFolder", () => {
    it("成功删除分支", async () => {
      const folder = createMockFolder({ id: 1 });
      useDocumentStore.setState({ folders: [folder] });
      mockDocumentApi.deleteFolder.mockResolvedValueOnce(undefined);

      const { deleteFolder } = useDocumentStore.getState();
      await deleteFolder(1);

      expect(useDocumentStore.getState().folders).toHaveLength(0);
    });

    it("删除当前选中分支时重置 currentFolderId", async () => {
      const folder = createMockFolder({ id: 1 });
      useDocumentStore.setState({ folders: [folder], currentFolderId: 1 });
      mockDocumentApi.deleteFolder.mockResolvedValueOnce(undefined);

      const { deleteFolder } = useDocumentStore.getState();
      await deleteFolder(1);

      expect(useDocumentStore.getState().currentFolderId).toBeNull();
    });

    it("删除非选中分支时保留 currentFolderId", async () => {
      const folder1 = createMockFolder({ id: 1 });
      const folder2 = createMockFolder({ id: 2 });
      useDocumentStore.setState({
        folders: [folder1, folder2],
        currentFolderId: 2,
      });
      mockDocumentApi.deleteFolder.mockResolvedValueOnce(undefined);

      const { deleteFolder } = useDocumentStore.getState();
      await deleteFolder(1);

      expect(useDocumentStore.getState().currentFolderId).toBe(2);
    });

    it("删除失败时设置 error 并抛出", async () => {
      const folder = createMockFolder({ id: 1 });
      useDocumentStore.setState({ folders: [folder] });
      mockDocumentApi.deleteFolder.mockRejectedValueOnce(
        new Error("删除分支失败"),
      );

      const { deleteFolder } = useDocumentStore.getState();
      await expect(deleteFolder(1)).rejects.toThrow("删除分支失败");

      expect(useDocumentStore.getState().error).toBe("删除分支失败");
    });
  });

  describe("loadFolders - 错误路径", () => {
    it("加载失败时设置 foldersLoading=false 和 error", async () => {
      mockDocumentApi.getFolders.mockRejectedValueOnce(new Error("加载失败"));

      const { loadFolders } = useDocumentStore.getState();
      await loadFolders();

      const state = useDocumentStore.getState();
      expect(state.foldersLoading).toBe(false);
      expect(state.error).toBe("加载失败");
    });
  });

  // ===== 轮询管理测试 =====
  describe("startPollingIfNeeded", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("为 processing 状态且有 task_id 的文档启动轮询", async () => {
      const doc = createMockDocument({
        id: 1,
        status: "processing",
        task_id: "task-123",
        processing_progress: 50,
      });
      useDocumentStore.setState({ documents: [doc] });

      mockDocumentApi.getTaskStatus.mockResolvedValue({
        task_id: "task-123",
        status: "STARTED",
        progress: 60,
        result: null,
        error: null,
      });

      const { startPollingIfNeeded } = useDocumentStore.getState();
      startPollingIfNeeded();

      // startDocumentPoll 立即执行一次 poll
      await vi.advanceTimersByTimeAsync(0);

      expect(mockDocumentApi.getTaskStatus).toHaveBeenCalledWith(1);
      expect(useDocumentStore.getState().documents[0].processing_progress).toBe(
        60,
      );
    });

    it("SUCCESS 状态映射为 completed 并重新加载列表", async () => {
      const doc = createMockDocument({
        id: 1,
        status: "processing",
        task_id: "task-123",
      });
      useDocumentStore.setState({ documents: [doc] });

      mockDocumentApi.getTaskStatus.mockResolvedValueOnce({
        task_id: "task-123",
        status: "SUCCESS",
        progress: 100,
        result: null,
        error: null,
      });
      mockDocumentApi.getDocuments.mockResolvedValueOnce({
        items: [{ ...doc, status: "completed", processing_progress: 100 }],
        total: 1,
        page: 1,
        page_size: 20,
      });

      const { startPollingIfNeeded } = useDocumentStore.getState();
      startPollingIfNeeded();

      await vi.advanceTimersByTimeAsync(0);

      // 轮询回调更新了文档状态
      expect(useDocumentStore.getState().documents[0].status).toBe("completed");
    });

    it("FAILURE 状态映射为 failed", async () => {
      const doc = createMockDocument({
        id: 1,
        status: "processing",
        task_id: "task-123",
      });
      useDocumentStore.setState({ documents: [doc] });

      mockDocumentApi.getTaskStatus.mockResolvedValueOnce({
        task_id: "task-123",
        status: "FAILURE",
        progress: 50,
        result: null,
        error: "处理失败",
      });
      mockDocumentApi.getDocuments.mockResolvedValueOnce({
        items: [{ ...doc, status: "failed" }],
        total: 1,
        page: 1,
        page_size: 20,
      });

      const { startPollingIfNeeded } = useDocumentStore.getState();
      startPollingIfNeeded();

      await vi.advanceTimersByTimeAsync(0);

      expect(useDocumentStore.getState().documents[0].status).toBe("failed");
    });

    it("pending 状态且有 task_id 的文档也启动轮询", async () => {
      const doc = createMockDocument({
        id: 1,
        status: "pending",
        task_id: "task-456",
      });
      useDocumentStore.setState({ documents: [doc] });

      mockDocumentApi.getTaskStatus.mockResolvedValue({
        task_id: "task-456",
        status: "STARTED",
        progress: 10,
        result: null,
        error: null,
      });

      const { startPollingIfNeeded } = useDocumentStore.getState();
      startPollingIfNeeded();

      await vi.advanceTimersByTimeAsync(0);

      expect(mockDocumentApi.getTaskStatus).toHaveBeenCalledWith(1);
    });

    it("不为 completed 状态的文档启动轮询", () => {
      const doc = createMockDocument({
        id: 1,
        status: "completed",
        task_id: "task-123",
      });
      useDocumentStore.setState({ documents: [doc] });

      const { startPollingIfNeeded } = useDocumentStore.getState();
      startPollingIfNeeded();

      expect(mockDocumentApi.getTaskStatus).not.toHaveBeenCalled();
    });

    it("不为无 task_id 的文档启动轮询", () => {
      const doc = createMockDocument({
        id: 1,
        status: "processing",
        task_id: null,
      });
      useDocumentStore.setState({ documents: [doc] });

      const { startPollingIfNeeded } = useDocumentStore.getState();
      startPollingIfNeeded();

      expect(mockDocumentApi.getTaskStatus).not.toHaveBeenCalled();
    });

    it("轮询失败时停止该文档的轮询", async () => {
      const doc = createMockDocument({
        id: 1,
        status: "processing",
        task_id: "task-123",
      });
      useDocumentStore.setState({ documents: [doc] });

      mockDocumentApi.getTaskStatus.mockRejectedValueOnce(new Error("网络错误"));

      const { startPollingIfNeeded } = useDocumentStore.getState();
      startPollingIfNeeded();

      await vi.advanceTimersByTimeAsync(0);

      // 第一次调用失败
      expect(mockDocumentApi.getTaskStatus).toHaveBeenCalledOnce();

      // 推进时间，不应再次调用（轮询已停止）
      await vi.advanceTimersByTimeAsync(10000);
      expect(mockDocumentApi.getTaskStatus).toHaveBeenCalledOnce();
    });

    it("同步更新预览中的文档状态", async () => {
      const doc = createMockDocument({
        id: 1,
        status: "processing",
        task_id: "task-123",
        processing_progress: 50,
      });
      useDocumentStore.setState({
        documents: [doc],
        previewDocument: doc,
        previewOpen: true,
      });

      mockDocumentApi.getTaskStatus.mockResolvedValue({
        task_id: "task-123",
        status: "STARTED",
        progress: 75,
        result: null,
        error: null,
      });

      const { startPollingIfNeeded } = useDocumentStore.getState();
      startPollingIfNeeded();

      await vi.advanceTimersByTimeAsync(0);

      expect(
        useDocumentStore.getState().previewDocument?.processing_progress,
      ).toBe(75);
    });

    it("停止已不在列表中的文档轮询", async () => {
      // 先启动一个轮询
      const doc = createMockDocument({
        id: 1,
        status: "processing",
        task_id: "task-123",
      });
      useDocumentStore.setState({ documents: [doc] });

      mockDocumentApi.getTaskStatus.mockResolvedValue({
        task_id: "task-123",
        status: "STARTED",
        progress: 50,
        result: null,
        error: null,
      });

      const { startPollingIfNeeded } = useDocumentStore.getState();
      startPollingIfNeeded();
      await vi.advanceTimersByTimeAsync(0);

      // 文档从列表中移除（变为 completed 无 task_id）
      useDocumentStore.setState({
        documents: [{ ...doc, status: "completed", task_id: null }],
      });

      // 再次调用 startPollingIfNeeded，应停止旧轮询
      startPollingIfNeeded();

      const callCount = mockDocumentApi.getTaskStatus.mock.calls.length;

      // 推进时间，不应再有调用
      await vi.advanceTimersByTimeAsync(10000);
      expect(mockDocumentApi.getTaskStatus).toHaveBeenCalledTimes(callCount);
    });
  });

  describe("stopAllPolling", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("停止所有轮询后不再调用 getTaskStatus", async () => {
      const doc = createMockDocument({
        id: 1,
        status: "processing",
        task_id: "task-123",
      });
      useDocumentStore.setState({ documents: [doc] });

      mockDocumentApi.getTaskStatus.mockResolvedValue({
        task_id: "task-123",
        status: "STARTED",
        progress: 60,
        result: null,
        error: null,
      });

      const { startPollingIfNeeded, stopAllPolling } = useDocumentStore.getState();
      startPollingIfNeeded();
      await vi.advanceTimersByTimeAsync(0);

      stopAllPolling();

      const callCount = mockDocumentApi.getTaskStatus.mock.calls.length;

      // 推进时间，不应再有调用
      await vi.advanceTimersByTimeAsync(10000);
      expect(mockDocumentApi.getTaskStatus).toHaveBeenCalledTimes(callCount);
    });
  });
});
