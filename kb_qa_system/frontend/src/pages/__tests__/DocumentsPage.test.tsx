/**
 * DocumentsPage 页面测试
 *
 * 覆盖范围：
 *   - 渲染验证：页面布局、标题、子组件
 *   - 加载行为：mount 时调用 loadFolders 和 loadDocuments
 *   - 空列表状态：显示完整上传区
 *   - 分页控件：total > pageSize 时显示分页
 *
 * Mock 策略：mock documentStore + 所有子组件（简化渲染）
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const { auth } = vi.hoisted(() => ({ auth: { user: { id: 1, user_type: 'registered' } as { id: number; user_type: string } | null } }));
vi.mock('@/store/authStore', () => ({ useAuthStore: () => auth }));

// Mock documentStore
const { mockDocStore } = vi.hoisted(() => ({
  mockDocStore: {
    folders: [] as Array<{ id: number; name: string }>,
    currentFolderId: null as number | null,
    currentScope: "accessible" as const,
    searchKeyword: "",
    documentFilters: { status: "", file_type: "", date_from: "", date_to: "" },
    documents: [] as Array<{ id: number; file_name: string }>,
    total: 0,
    page: 1,
    pageSize: 20,
    loadFolders: vi.fn(),
    loadDocuments: vi.fn(),
    selectFolder: vi.fn(),
    setPage: vi.fn(),
    stopAllPolling: vi.fn(),
  },
}));

vi.mock("@/store/documentStore", () => ({
  useDocumentStore: () => mockDocStore,
}));

// Mock useParams
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return {
    ...actual,
    useParams: () => ({ folderId: undefined }),
  };
});

// Mock 子组件 — 简化为带 data-testid 的占位
vi.mock("@/components/documents/Sidebar", () => ({
  Sidebar: () => <div data-testid="sidebar" />,
}));
vi.mock("@/components/documents/DocumentList", () => ({
  DocumentList: () => <div data-testid="document-list" />,
}));
vi.mock("@/components/documents/DocumentPreview", () => ({
  DocumentPreview: () => <div data-testid="document-preview" />,
}));
vi.mock("@/components/documents/SearchBar", () => ({
  SearchBar: () => <div data-testid="search-bar" />,
}));
vi.mock("@/components/documents/SortDropdown", () => ({
  SortDropdown: () => <div data-testid="sort-dropdown" />,
}));
vi.mock("@/components/documents/UploadZone", () => ({
  UploadZone: () => <div data-testid="upload-zone" />,
}));
vi.mock("@/components/documents/Pagination", () => ({
  Pagination: ({
    current,
    total,
    pageSize,
  }: {
    current: number;
    total: number;
    pageSize: number;
    onChange: (page: number) => void;
  }) => (
    <div data-testid="pagination">
      页 {current} / 共 {Math.ceil(total / pageSize)} 页
    </div>
  ),
}));
vi.mock("@/components/documents/StatsPanel", () => ({
  StatsPanel: () => <div data-testid="stats-panel" />,
}));
vi.mock("@/components/documents/UrlImportModal", () => ({
  UrlImportModal: () => <div data-testid="url-import-modal" />,
}));

import DocumentsPage from "@/pages/DocumentsPage";

function renderPage() {
  return render(
    <MemoryRouter>
      <DocumentsPage />
    </MemoryRouter>,
  );
}

describe("DocumentsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.user = { id: 1, user_type: 'registered' };
    mockDocStore.folders = [];
    mockDocStore.currentFolderId = null;
    mockDocStore.currentScope = "accessible";
    mockDocStore.searchKeyword = "";
    mockDocStore.documentFilters = { status: "", file_type: "", date_from: "", date_to: "" };
    mockDocStore.documents = [];
    mockDocStore.total = 0;
    mockDocStore.page = 1;
    mockDocStore.pageSize = 20;
  });

  it("渲染页面标题（默认全部文档）", () => {
    renderPage();
    expect(screen.getByText("全部文档")).toBeInTheDocument();
  });

  it("mount 时调用 loadFolders", () => {
    renderPage();
    expect(mockDocStore.loadFolders).toHaveBeenCalledTimes(1);
  });

  it('登录前不加载分支，登录及切换账号后重新加载', () => {
    auth.user = null;
    const { rerender } = renderPage();
    expect(mockDocStore.loadFolders).not.toHaveBeenCalled();
    auth.user = { id: 1, user_type: 'registered' };
    rerender(<MemoryRouter><DocumentsPage /></MemoryRouter>);
    expect(mockDocStore.loadFolders).toHaveBeenCalledTimes(1);
    auth.user = { id: 2, user_type: 'registered' };
    rerender(<MemoryRouter><DocumentsPage /></MemoryRouter>);
    expect(mockDocStore.loadFolders).toHaveBeenCalledTimes(2);
  });

  it("渲染核心子组件", () => {
    // 非空列表时才渲染 DocumentList（空列表时显示 UploadZone）
    mockDocStore.documents = [{ id: 1, file_name: "test.pdf" }];
    mockDocStore.total = 1;
    renderPage();
    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("document-list")).toBeInTheDocument();
    // SearchBar 有桌面端和移动端两个实例，用 getAllByTestId
    expect(screen.getAllByTestId("search-bar").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId("sort-dropdown")).toBeInTheDocument();
  });

  it("空列表时显示上传区域", () => {
    mockDocStore.documents = [];
    mockDocStore.total = 0;
    renderPage();
    // 空列表时 UploadZone 出现两次（toolbar + 空状态区）
    expect(screen.getAllByTestId("upload-zone").length).toBeGreaterThanOrEqual(1);
  });

  it("有文档时不显示分页（total <= pageSize）", () => {
    mockDocStore.documents = [{ id: 1, file_name: "test.pdf" }];
    mockDocStore.total = 5;
    mockDocStore.pageSize = 20;
    renderPage();
    expect(screen.queryByTestId("pagination")).not.toBeInTheDocument();
  });

  it("total > pageSize 时显示分页控件", () => {
    mockDocStore.documents = [{ id: 1, file_name: "test.pdf" }];
    mockDocStore.total = 50;
    mockDocStore.pageSize = 20;
    renderPage();
    expect(screen.getByTestId("pagination")).toBeInTheDocument();
    expect(screen.getByText(/页 1/)).toBeInTheDocument();
  });

  it("文档总数显示在标题旁", () => {
    mockDocStore.total = 42;
    renderPage();
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("组件卸载时调用 stopAllPolling", () => {
    const { unmount } = renderPage();
    unmount();
    expect(mockDocStore.stopAllPolling).toHaveBeenCalledTimes(1);
  });

  it("当前分支有名称时显示分支名", () => {
    mockDocStore.folders = [{ id: 5, name: "技术文档" }];
    mockDocStore.currentFolderId = 5;
    renderPage();
    expect(screen.getByText("技术文档")).toBeInTheDocument();
  });
});
