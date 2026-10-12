/**
 * document.ts 单元测试
 *
 * 覆盖范围：
 *   - getDocuments：查询参数构建（含 Bug-1 folder_id 验证）
 *   - getDocumentDetail：路径参数
 *   - deleteDocument：DELETE 请求
 *   - getFolders / createFolder / updateFolder / deleteFolder：API 调用验证
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// 使用 vi.hoisted 确保 mock 对象在 vi.mock 提升时可用
const { mockApiClient } = vi.hoisted(() => ({
  mockApiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    upload: vi.fn(),
  },
}));

vi.mock("@/api/client", () => ({
  apiClient: mockApiClient,
}));

import {
  getDocuments,
  getDocumentDetail,
  deleteDocument,
  reprocessDocument,
  uploadDocument,
  getTaskStatus,
  getFolders,
  createFolder,
  updateFolder,
  deleteFolder,
} from "@/api/document";
import type { DocumentResponse } from "@/types/document";

describe("getDocuments", () => {
  beforeEach(() => {
    mockApiClient.get.mockReset();
  });

  it("无参数时请求基础路径", async () => {
    mockApiClient.get.mockResolvedValueOnce({ items: [], total: 0, page: 1, page_size: 20 });
    await getDocuments({});
    expect(mockApiClient.get).toHaveBeenCalledOnce();
    const endpoint = mockApiClient.get.mock.calls[0][0];
    expect(endpoint).toMatch(/\/documents/);
  });

  it("[Bug-1 验证] folder_id 参数被正确传递到查询字符串", async () => {
    mockApiClient.get.mockResolvedValueOnce({ items: [], total: 0, page: 1, page_size: 20 });
    await getDocuments({ folder_id: 42 });
    const endpoint = mockApiClient.get.mock.calls[0][0];
    expect(endpoint).toContain("folder_id=42");
  });

  it("page 和 page_size 参数正确传递", async () => {
    mockApiClient.get.mockResolvedValueOnce({ items: [], total: 0, page: 2, page_size: 10 });
    await getDocuments({ page: 2, page_size: 10 });
    const endpoint = mockApiClient.get.mock.calls[0][0];
    expect(endpoint).toContain("page=2");
    expect(endpoint).toContain("page_size=10");
  });

  it("search 参数正确传递", async () => {
    mockApiClient.get.mockResolvedValueOnce({ items: [], total: 0, page: 1, page_size: 20 });
    await getDocuments({ search: "测试文档" });
    const endpoint = mockApiClient.get.mock.calls[0][0];
    expect(endpoint).toContain("search=");
    expect(endpoint).toContain(encodeURIComponent("测试文档"));
  });

  it("sort_by 和 sort_order 参数正确传递", async () => {
    mockApiClient.get.mockResolvedValueOnce({ items: [], total: 0, page: 1, page_size: 20 });
    await getDocuments({ sort_by: "file_name", sort_order: "asc" });
    const endpoint = mockApiClient.get.mock.calls[0][0];
    expect(endpoint).toContain("sort_by=file_name");
    expect(endpoint).toContain("sort_order=asc");
  });

  it("status 参数正确传递", async () => {
    mockApiClient.get.mockResolvedValueOnce({ items: [], total: 0, page: 1, page_size: 20 });
    await getDocuments({ status: "completed" });
    const endpoint = mockApiClient.get.mock.calls[0][0];
    expect(endpoint).toContain("status=completed");
  });

  it("文件类型和含边界日期参数正确传递", async () => {
    mockApiClient.get.mockResolvedValueOnce({ items: [], total: 0, page: 1, page_size: 20 });
    await getDocuments({ file_type: ".pdf", date_from: "2026-10-01", date_to: "2026-10-12" });
    const endpoint = mockApiClient.get.mock.calls[0][0];
    expect(endpoint).toContain("file_type=.pdf");
    expect(endpoint).toContain("date_from=2026-10-01");
    expect(endpoint).toContain("date_to=2026-10-12");
  });

  it("所有参数组合时全部传递", async () => {
    mockApiClient.get.mockResolvedValueOnce({ items: [], total: 0, page: 1, page_size: 20 });
    await getDocuments({
      page: 1,
      page_size: 20,
      search: "report",
      sort_by: "created_at",
      sort_order: "desc",
      folder_id: 5,
      status: "completed",
    });
    const endpoint = mockApiClient.get.mock.calls[0][0];
    expect(endpoint).toContain("page=1");
    expect(endpoint).toContain("page_size=20");
    expect(endpoint).toContain("search=report");
    expect(endpoint).toContain("sort_by=created_at");
    expect(endpoint).toContain("sort_order=desc");
    expect(endpoint).toContain("folder_id=5");
    expect(endpoint).toContain("status=completed");
  });
});

describe("getDocumentDetail", () => {
  beforeEach(() => {
    mockApiClient.get.mockReset();
  });

  it("使用正确的文档 ID 路径", async () => {
    const mockDoc: DocumentResponse = {
      id: 123,
      title: "Test",
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
      chunk_count: 10,
      total_tokens: 500,
      task_id: null,
      error_message: null,
      created_at: "2026-07-10T00:00:00Z",
      updated_at: "2026-07-10T00:00:00Z",
    };
    mockApiClient.get.mockResolvedValueOnce(mockDoc);
    await getDocumentDetail(123);
    const endpoint = mockApiClient.get.mock.calls[0][0];
    expect(endpoint).toContain("/documents/123");
  });
});

describe("deleteDocument", () => {
  beforeEach(() => {
    mockApiClient.delete.mockReset();
  });

  it("调用 DELETE 方法", async () => {
    mockApiClient.delete.mockResolvedValueOnce(undefined);
    await deleteDocument(456);
    expect(mockApiClient.delete).toHaveBeenCalledOnce();
    const endpoint = mockApiClient.delete.mock.calls[0][0];
    expect(endpoint).toContain("/documents/456");
  });
});

describe("reprocessDocument", () => {
  beforeEach(() => {
    mockApiClient.post.mockReset();
  });

  it("调用 POST 重新处理", async () => {
    mockApiClient.post.mockResolvedValueOnce({ task_id: "task123" });
    await reprocessDocument(789);
    expect(mockApiClient.post).toHaveBeenCalledOnce();
    const endpoint = mockApiClient.post.mock.calls[0][0];
    expect(endpoint).toContain("/documents/789/reprocess");
  });
});

describe("uploadDocument", () => {
  beforeEach(() => {
    mockApiClient.upload.mockReset();
  });

  it("构建 FormData 并调用 upload（仅 file）", async () => {
    const mockDoc: DocumentResponse = {
      id: 1,
      title: "test",
      file_name: "test.pdf",
      file_type: ".pdf",
      file_size: 1024,
      status: "pending",
      visibility: "private",
      folder_id: null,
      processing_step: null,
      processing_progress: 0,
      quality_score: null,
      quality_issues: null,
      chunk_count: 0,
      total_tokens: 0,
      task_id: "task-1",
      error_message: null,
      created_at: "2026-07-10T00:00:00Z",
      updated_at: "2026-07-10T00:00:00Z",
    };
    mockApiClient.upload.mockResolvedValueOnce(mockDoc);

    const file = new File(["content"], "test.pdf");
    const result = await uploadDocument({ file });

    expect(result).toEqual(mockDoc);
    expect(mockApiClient.upload).toHaveBeenCalledOnce();

    // 验证传递给 upload 的参数
    const [endpoint, formData, onProgress, signal] = mockApiClient.upload.mock.calls[0];
    expect(endpoint).toContain("/documents/upload");
    expect(formData).toBeInstanceOf(FormData);
    expect(formData.get("file")).toBe(file);
    expect(onProgress).toBeUndefined();
    expect(signal).toBeUndefined();
  });

  it("完整参数（title/category/visibility/folder_id）全部附加到 FormData", async () => {
    mockApiClient.upload.mockResolvedValueOnce({ id: 1 });

    const file = new File(["content"], "report.pdf");
    await uploadDocument({
      file,
      title: "季度报告",
      category: "report",
      visibility: "public",
      folder_id: 42,
    });

    const formData = mockApiClient.upload.mock.calls[0][1] as FormData;
    expect(formData.get("file")).toBe(file);
    expect(formData.get("title")).toBe("季度报告");
    expect(formData.get("category")).toBe("report");
    expect(formData.get("visibility")).toBe("public");
    expect(formData.get("folder_id")).toBe("42");
  });

  it("conflict_resolution 参数被正确附加到 FormData", async () => {
    mockApiClient.upload.mockResolvedValueOnce({ id: 1 });

    const file = new File(["content"], "dup.pdf");
    await uploadDocument({
      file,
      conflict_resolution: "overwrite",
    });

    const formData = mockApiClient.upload.mock.calls[0][1] as FormData;
    expect(formData.get("conflict_resolution")).toBe("overwrite");
  });

  it("不传 conflict_resolution 时不附加该字段到 FormData", async () => {
    mockApiClient.upload.mockResolvedValueOnce({ id: 1 });

    const file = new File(["content"], "plain.pdf");
    await uploadDocument({ file });

    const formData = mockApiClient.upload.mock.calls[0][1] as FormData;
    expect(formData.get("conflict_resolution")).toBeNull();
  });

  it("传递 onProgress 和 signal 到 upload", async () => {
    mockApiClient.upload.mockResolvedValueOnce({ id: 1 });

    const onProgress = vi.fn();
    const controller = new AbortController();
    await uploadDocument(
      { file: new File(["content"], "test.pdf") },
      onProgress,
      controller.signal,
    );

    const [, , progressCb, signal] = mockApiClient.upload.mock.calls[0];
    expect(progressCb).toBe(onProgress);
    expect(signal).toBe(controller.signal);
  });
});

describe("getTaskStatus", () => {
  beforeEach(() => {
    mockApiClient.get.mockReset();
  });

  it("使用正确的 document_id 路径", async () => {
    mockApiClient.get.mockResolvedValueOnce({
      task_id: "task-123",
      status: "SUCCESS",
      progress: 100,
      result: null,
      error: null,
    });

    await getTaskStatus(123);

    expect(mockApiClient.get).toHaveBeenCalledOnce();
    const endpoint = mockApiClient.get.mock.calls[0][0];
    expect(endpoint).toContain("/documents/123/task-status");
  });
});

describe("Folders API 调用", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("getFolders - 调用 GET /documents/folders 并返回分支列表", async () => {
    const mockResponse = {
      items: [
        { id: 1, name: "默认分支", document_count: 5 },
        { id: 2, name: "技术文档", document_count: 3 },
      ],
      total: 2,
    };
    mockApiClient.get.mockResolvedValueOnce(mockResponse);

    const result = await getFolders();

    expect(mockApiClient.get).toHaveBeenCalledOnce();
    expect(mockApiClient.get).toHaveBeenCalledWith("/documents/folders");
    expect(result.items).toHaveLength(2);
    expect(result.items[0].name).toBe("默认分支");
    expect(result.total).toBe(2);
  });

  it("createFolder - 调用 POST /documents/folders 并返回新建分支", async () => {
    const mockFolder = { id: 10, name: "测试分支", document_count: 0 };
    mockApiClient.post.mockResolvedValueOnce(mockFolder);

    const created = await createFolder({ name: "测试分支" });

    expect(mockApiClient.post).toHaveBeenCalledOnce();
    expect(mockApiClient.post).toHaveBeenCalledWith("/documents/folders", {
      name: "测试分支",
    });
    expect(created.name).toBe("测试分支");
    expect(created.id).toBe(10);
  });

  it("updateFolder - 调用 PATCH /documents/folders/{id} 并返回更新后的分支", async () => {
    const mockFolder = { id: 5, name: "新名称", document_count: 2 };
    mockApiClient.patch.mockResolvedValueOnce(mockFolder);

    const updated = await updateFolder(5, { name: "新名称" });

    expect(mockApiClient.patch).toHaveBeenCalledOnce();
    expect(mockApiClient.patch).toHaveBeenCalledWith(
      "/documents/folders/5",
      { name: "新名称" },
    );
    expect(updated.name).toBe("新名称");
    expect(updated.id).toBe(5);
  });

  it("deleteFolder - 调用 DELETE /documents/folders/{id}", async () => {
    mockApiClient.delete.mockResolvedValueOnce(undefined);

    await deleteFolder(3);

    expect(mockApiClient.delete).toHaveBeenCalledOnce();
    expect(mockApiClient.delete).toHaveBeenCalledWith("/documents/folders/3");
  });
});
