/**
 * DocumentList 组件集成测试
 *
 * 覆盖范围：
 *   - loading 状态：显示骨架屏
 *   - error 状态：显示错误信息和重试按钮
 *   - 空列表：显示空状态提示
 *   - 搜索无结果：显示"未找到匹配的文档"
 *   - 有数据：渲染文档列表
 *
 * Mock 策略：mock @/store/documentStore，控制不同状态
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock documentStore
const { mockDocStore } = vi.hoisted(() => ({
  mockDocStore: {
    documents: [],
    loading: false,
    error: null,
    searchKeyword: "",
    documentFilters: { status: "", file_type: "", date_from: "", date_to: "" },
    loadDocuments: vi.fn(),
    clearError: vi.fn(),
    selectionMode: false,
    selectedDocIds: new Set<number>(),
    toggleSelect: vi.fn(),
    openPreview: vi.fn(),
    removeDocument: vi.fn(),
    reprocessDocument: vi.fn(),
  },
}));

vi.mock("@/store/documentStore", () => ({
  useDocumentStore: () => mockDocStore,
}));

// mock MoveToFolderModal 以避免其从 store 读取 folders（DocumentList 通过 DocumentItem 间接渲染此组件）
vi.mock("../MoveToFolderModal", () => ({
  MoveToFolderModal: () => null,
}));

import { DocumentList } from "../DocumentList";
import type { DocumentResponse } from "@/types/document";

/** 创建测试用文档 */
function createMockDoc(overrides: Partial<DocumentResponse> = {}): DocumentResponse {
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
    total_tokens: 1000,
    task_id: null,
    error_message: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("DocumentList 组件", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDocStore.documents = [];
    mockDocStore.loading = false;
    mockDocStore.error = null;
    mockDocStore.searchKeyword = "";
    mockDocStore.documentFilters = { status: "", file_type: "", date_from: "", date_to: "" };
  });

  it("loading 状态显示骨架屏", () => {
    mockDocStore.loading = true;
    render(<DocumentList />);
    // 骨架屏渲染多个骨架块（不报错即正常）
    expect(screen.queryByText("暂无文档")).not.toBeInTheDocument();
  });

  it("error 状态显示错误信息和重试按钮", () => {
    mockDocStore.error = "加载文档失败";
    render(<DocumentList />);
    expect(screen.getByText("加载文档失败")).toBeInTheDocument();
    expect(screen.getByText("重试")).toBeInTheDocument();
  });

  it("error 状态点击重试 - 调用 clearError 和 loadDocuments", async () => {
    const user = userEvent.setup();
    mockDocStore.error = "加载失败";
    render(<DocumentList />);
    await user.click(screen.getByText("重试"));
    expect(mockDocStore.clearError).toHaveBeenCalledTimes(1);
    expect(mockDocStore.loadDocuments).toHaveBeenCalledTimes(1);
  });

  it("空列表显示空状态提示", () => {
    render(<DocumentList />);
    expect(screen.getByText("暂无文档")).toBeInTheDocument();
    expect(
      screen.getByText("点击上方上传按钮或拖拽文件到上传区添加文档"),
    ).toBeInTheDocument();
  });

  it("搜索无结果显示未找到提示", () => {
    mockDocStore.searchKeyword = "报告";
    render(<DocumentList />);
    expect(screen.getByText("未找到匹配的文档")).toBeInTheDocument();
    expect(screen.getByText(/没有找到标题或文件名包含"报告"的文档/)).toBeInTheDocument();
  });

  it("筛选无结果时显示筛选空状态，不提示知识库为空", () => {
    mockDocStore.documentFilters = { status: "failed", file_type: "", date_from: "", date_to: "" };
    render(<DocumentList />);
    expect(screen.getByText("没有符合条件的文档")).toBeInTheDocument();
    expect(screen.getByText("请调整当前筛选条件。")).toBeInTheDocument();
  });

  it("有数据时渲染文档列表", () => {
    mockDocStore.documents = [
      createMockDoc({ id: 1, file_name: "doc1.pdf" }),
      createMockDoc({ id: 2, file_name: "doc2.pdf" }),
    ];
    render(<DocumentList />);
    expect(screen.getByText("doc1.pdf")).toBeInTheDocument();
    expect(screen.getByText("doc2.pdf")).toBeInTheDocument();
  });

  it("processing 状态文档显示进度信息", () => {
    mockDocStore.documents = [
      createMockDoc({
        status: "processing",
        processing_step: "解析中",
        processing_progress: 50,
      }),
    ];
    render(<DocumentList />);
    expect(screen.getByText("解析中")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
  });
});
