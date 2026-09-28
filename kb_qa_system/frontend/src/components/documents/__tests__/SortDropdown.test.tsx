/**
 * SortDropdown 组件集成测试
 *
 * 覆盖范围：
 *   - 渲染：当前排序字段标签、升降序指示器
 *   - 交互：点击展开/收起下拉菜单
 *   - 选择：选择新字段调用 setSort、同字段切换升降序
 *   - 升降序切换按钮
 *   - 点击外部关闭下拉
 *
 * Mock 策略：mock @/store/documentStore
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SortField, SortOrder } from "@/types/document";

const { mockDocStore } = vi.hoisted(() => ({
  mockDocStore: {
    sortBy: "created_at" as SortField,
    sortOrder: "desc" as SortOrder,
    setSort: vi.fn(),
  },
}));

vi.mock("@/store/documentStore", () => ({
  useDocumentStore: () => mockDocStore,
}));

import { SortDropdown } from "../SortDropdown";

describe("SortDropdown 组件", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDocStore.sortBy = "created_at";
    mockDocStore.sortOrder = "desc";
  });

  it("渲染当前排序字段标签", () => {
    render(<SortDropdown />);
    expect(screen.getByText("创建时间")).toBeInTheDocument();
  });

  it("desc 状态显示降序图标", () => {
    render(<SortDropdown />);
    expect(screen.getByLabelText("切换为升序")).toBeInTheDocument();
  });

  it("asc 状态显示升序图标", () => {
    mockDocStore.sortOrder = "asc";
    render(<SortDropdown />);
    expect(screen.getByLabelText("切换为降序")).toBeInTheDocument();
  });

  it("点击按钮展开下拉菜单", async () => {
    const user = userEvent.setup();
    render(<SortDropdown />);
    // 初始不显示选项
    expect(screen.queryByText("修改时间")).not.toBeInTheDocument();
    // 点击展开
    await user.click(screen.getByText("创建时间"));
    expect(screen.getByText("修改时间")).toBeInTheDocument();
    expect(screen.getByText("文件名称")).toBeInTheDocument();
    expect(screen.getByText("文件类型")).toBeInTheDocument();
  });

  it("选择新字段调用 setSort（默认降序）", async () => {
    const user = userEvent.setup();
    render(<SortDropdown />);
    await user.click(screen.getByText("创建时间"));
    await user.click(screen.getByText("文件名称"));
    expect(mockDocStore.setSort).toHaveBeenCalledWith("file_name", "desc");
  });

  it("点击同字段切换升降序", async () => {
    const user = userEvent.setup();
    mockDocStore.sortBy = "created_at";
    mockDocStore.sortOrder = "desc";
    render(<SortDropdown />);
    // 点击触发器展开下拉
    await user.click(screen.getByText("创建时间"));
    // 展开后"创建时间"出现两次（触发器 + 选项），点击第二个（下拉选项）
    const options = screen.getAllByText("创建时间");
    await user.click(options[1]);
    expect(mockDocStore.setSort).toHaveBeenCalledWith("created_at", "asc");
  });

  it("升降序切换按钮调用 setSort", async () => {
    const user = userEvent.setup();
    mockDocStore.sortOrder = "desc";
    render(<SortDropdown />);
    await user.click(screen.getByLabelText("切换为升序"));
    expect(mockDocStore.setSort).toHaveBeenCalledWith("created_at", "asc");
  });

  it("keeps sort selection and direction as separate keyboard controls", async () => {
    const user = userEvent.setup();
    render(<SortDropdown />);
    const select = screen.getByRole('button', { name: '创建时间' });
    const direction = screen.getByRole('button', { name: '切换为升序' });
    expect(select.contains(direction)).toBe(false);
    await user.tab(); expect(select).toHaveFocus();
    await user.tab(); expect(direction).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(mockDocStore.setSort).toHaveBeenCalledTimes(1);
    expect(mockDocStore.setSort).toHaveBeenCalledWith('created_at', 'asc');
    expect(select).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('修改时间')).not.toBeInTheDocument();
  });

  it("点击外部关闭下拉菜单", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <SortDropdown />
        <button>外部按钮</button>
      </div>,
    );
    // 展开
    await user.click(screen.getByText("创建时间"));
    expect(screen.getByText("修改时间")).toBeInTheDocument();
    // 点击外部
    await user.click(screen.getByText("外部按钮"));
    expect(screen.queryByText("修改时间")).not.toBeInTheDocument();
  });
});
