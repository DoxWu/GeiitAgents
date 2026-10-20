/**
 * SettingsPage 页面测试
 *
 * 覆盖范围：
 *   - 渲染验证：标题、账号信息、快捷功能
 *   - 用户信息展示：用户名、邮箱、注册时间
 *   - 管理员功能：is_superuser 时显示注册管理入口
 *   - 登出：点击后调用 logout 并跳转
 *   - 数据导出：点击后调用 exportUserData
 *   - 删除账号：点击后打开弹窗
 *   - 未登录防御：user 为 null 时返回 null
 *
 * Mock 策略：mock authStore, toastStore, auth API, DeleteAccountModal
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

// Mock authStore
const { mockAuthStore } = vi.hoisted(() => ({
  mockAuthStore: {
    user: {
      id: 1,
      username: "testuser",
      email: "test@example.com",
      is_superuser: false,
      is_active: true,
      created_at: "2026-01-15T00:00:00Z",
    },
    logout: vi.fn(),
  },
}));

vi.mock("@/store/authStore", () => ({
  useAuthStore: () => mockAuthStore,
}));

// Mock toastStore
const { mockToastStore } = vi.hoisted(() => ({
  mockToastStore: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/store/toastStore", () => ({
  useToastStore: () => mockToastStore,
}));

// Mock navigate
const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// Mock auth API
vi.mock("@/api/auth", () => ({
  exportUserData: vi.fn(),
}));

// Mock DeleteAccountModal
vi.mock("@/components/settings/DeleteAccountModal", () => ({
  DeleteAccountModal: ({
    open,
    onClose,
    username,
  }: {
    open: boolean;
    onClose: () => void;
    username: string;
  }) =>
    open ? (
      <div data-testid="delete-modal">
        <span data-testid="delete-modal-username">{username}</span>
        <button onClick={onClose} data-testid="close-delete-modal">
          关闭
        </button>
      </div>
    ) : null,
}));

// Mock Button 组件（简化）
vi.mock("@/components/common/Button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    variant,
    icon,
    fullWidth,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    variant?: string;
    icon?: React.ReactNode;
    fullWidth?: boolean;
  }) => (
    <button
      onClick={onClick}
      disabled={disabled}
      data-variant={variant}
      data-fullwidth={fullWidth}
    >
      {icon}
      {children}
    </button>
  ),
}));

import SettingsPage from "@/pages/SettingsPage";
import { exportUserData } from "@/api/auth";

function renderPage() {
  return render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );
}

describe("SettingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockAuthStore.user = {
      id: 1,
      username: "testuser",
      email: "test@example.com",
      is_superuser: false,
      is_active: true,
      created_at: "2026-01-15T00:00:00Z",
    };
  });

  it("渲染页面标题", () => {
    renderPage();
    expect(screen.getByText("设置")).toBeInTheDocument();
  });

  it("重排默认保持现状，选择后在重新打开设置时保留", async () => {
    const user = userEvent.setup();
    const view = renderPage();
    expect(screen.getByRole('combobox', { name: '重排方案' })).toHaveValue('current');
    await user.selectOptions(screen.getByRole('combobox', { name: '重排方案' }), 'qwen3.7-text-rerank');
    view.unmount();
    renderPage();
    expect(screen.getByRole('combobox', { name: '重排方案' })).toHaveValue('qwen3.7-text-rerank');
  });

  it("显示用户名", () => {
    renderPage();
    expect(screen.getByText("testuser")).toBeInTheDocument();
  });

  it("显示邮箱", () => {
    renderPage();
    expect(screen.getByText("test@example.com")).toBeInTheDocument();
  });

  it("显示注册时间", () => {
    renderPage();
    // formatDate 将 ISO 转为中文日期格式
    expect(screen.getByText(/2026/)).toBeInTheDocument();
  });

  it("非管理员不显示注册管理入口", () => {
    renderPage();
    expect(screen.queryByText("注册申请管理")).not.toBeInTheDocument();
  });

  it("管理员显示注册管理入口", () => {
    mockAuthStore.user = { ...mockAuthStore.user!, is_superuser: true };
    renderPage();
    expect(screen.getByText("注册申请管理")).toBeInTheDocument();
  });

  it("非管理员不显示管理员标签", () => {
    renderPage();
    expect(screen.queryByText("管理员")).not.toBeInTheDocument();
  });

  it("管理员显示管理员标签", () => {
    mockAuthStore.user = { ...mockAuthStore.user!, is_superuser: true };
    renderPage();
    expect(screen.getByText("管理员")).toBeInTheDocument();
  });

  it("点击退出登录调用 logout 并跳转", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByText("退出登录"));
    expect(mockAuthStore.logout).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith("/login", { replace: true });
  });

  it("点击导出数据调用 exportUserData", async () => {
    const user = userEvent.setup();
    vi.mocked(exportUserData).mockResolvedValueOnce('{"data": "test"}');
    renderPage();
    await user.click(screen.getByText("导出数据"));
    expect(exportUserData).toHaveBeenCalledTimes(1);
  });

  it("点击删除账号打开弹窗", async () => {
    const user = userEvent.setup();
    renderPage();
    // "删除账号" 同时出现在 <p> 标签和按钮上，用 role 精确匹配按钮
    await user.click(screen.getByRole("button", { name: "删除账号" }));
    expect(screen.getByTestId("delete-modal")).toBeInTheDocument();
  });

  it("关闭删除账号弹窗", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "删除账号" }));
    expect(screen.getByTestId("delete-modal")).toBeInTheDocument();
    await user.click(screen.getByTestId("close-delete-modal"));
    expect(screen.queryByTestId("delete-modal")).not.toBeInTheDocument();
  });

  it("显示隐私政策和用户协议链接", () => {
    renderPage();
    expect(screen.getByText("隐私政策")).toBeInTheDocument();
    expect(screen.getByText("用户协议")).toBeInTheDocument();
  });

  it("user 为 null 时返回 null（防御性检查）", () => {
    mockAuthStore.user = null;
    const { container } = renderPage();
    expect(container.firstChild).toBeNull();
  });

  it("点击文档管理跳转到 /documents", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByText("文档管理"));
    expect(mockNavigate).toHaveBeenCalledWith("/documents");
  });

  it("点击问答对话跳转到 /chat", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByText("问答对话"));
    expect(mockNavigate).toHaveBeenCalledWith("/chat");
  });
});
