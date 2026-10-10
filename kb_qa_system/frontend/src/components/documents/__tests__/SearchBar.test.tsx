/**
 * SearchBar 组件集成测试
 *
 * 覆盖范围：
 *   - 渲染：搜索框、placeholder
 *   - 交互：输入触发 setSearchKeyword + 防抖 loadDocuments
 *   - 清空：点击 X 按钮清空输入
 *
 * Mock 策略：mock @/store/documentStore，控制 store 状态和方法
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock documentStore
const { mockDocStore } = vi.hoisted(() => ({
  mockDocStore: {
    searchKeyword: "",
    setSearchKeyword: vi.fn(),
    loadDocuments: vi.fn(),
    // D2-03 搜索历史（Task #143 新增）
    searchHistory: [] as string[],
    addSearchHistory: vi.fn(),
    clearSearchHistory: vi.fn(),
  },
}));

vi.mock("@/store/documentStore", () => ({
  useDocumentStore: () => mockDocStore,
}));

import { SearchBar } from "../SearchBar";

describe("SearchBar 组件", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockDocStore.searchKeyword = "";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("渲染搜索框和 placeholder", () => {
    render(<SearchBar />);
    expect(screen.getByPlaceholderText("搜索标题或文件名...")).toBeInTheDocument();
  });

  it("初始无输入时不显示清空按钮", () => {
    render(<SearchBar />);
    expect(screen.queryByLabelText("清空搜索")).not.toBeInTheDocument();
  });

  it("输入触发 setSearchKeyword", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<SearchBar />);
    const input = screen.getByPlaceholderText("搜索标题或文件名...");
    await user.type(input, "测试");
    expect(mockDocStore.setSearchKeyword).toHaveBeenCalled();
  });

  it("输入后 300ms 防抖触发 loadDocuments", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<SearchBar />);
    const input = screen.getByPlaceholderText("搜索标题或文件名...");
    await user.type(input, "文档");
    // 防抖延迟内未触发
    expect(mockDocStore.loadDocuments).not.toHaveBeenCalled();
    // 快进 300ms 后触发
    vi.advanceTimersByTime(300);
    expect(mockDocStore.loadDocuments).toHaveBeenCalled();
  });

  it("输入后显示清空按钮，点击清空输入", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<SearchBar />);
    const input = screen.getByPlaceholderText("搜索标题或文件名...");
    await user.type(input, "x");
    expect(screen.getByLabelText("清空搜索")).toBeInTheDocument();
    await user.click(screen.getByLabelText("清空搜索"));
    expect(screen.getByPlaceholderText("搜索标题或文件名...")).toHaveValue("");
  });
});
