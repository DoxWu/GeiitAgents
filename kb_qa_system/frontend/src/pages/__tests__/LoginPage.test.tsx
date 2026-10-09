/**
 * LoginPage 页面测试
 *
 * 覆盖范围：
 *   - 渲染验证：标题、副标题、注册链接
 *   - 已登录重定向：isAuthenticated=true 时跳转 /documents
 *   - 错误展示：store.error 存在时显示错误信息
 *   - 登录成功跳转：onSuccess 回调导航到 /documents
 *
 * Mock 策略：mock react-router-dom, authStore, AuthLayout, LoginForm
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

// Mock authStore
const { mockAuthStore } = vi.hoisted(() => ({
  mockAuthStore: {
    isAuthenticated: false,
    error: null as string | null,
  },
}));

vi.mock("@/store/authStore", () => ({
  useAuthStore: () => mockAuthStore,
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

// Mock AuthLayout — 简化为 wrapper
vi.mock("@/components/auth/AuthLayout", () => ({
  AuthLayout: ({
    title,
    subtitle,
    children,
    footer,
  }: {
    title: string;
    subtitle: string;
    children: React.ReactNode;
    footer?: React.ReactNode;
  }) => (
    <div>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      <div data-testid="layout-content">{children}</div>
      <div data-testid="layout-footer">{footer}</div>
    </div>
  ),
}));

// Mock LoginForm — 暴露 onSuccess 回调供测试触发
vi.mock("@/components/auth/LoginForm", () => ({
  LoginForm: ({ onSuccess }: { onSuccess: () => void }) => (
    <div data-testid="login-form">
      <button onClick={onSuccess} data-testid="login-success-btn">
        模拟登录成功
      </button>
    </div>
  ),
}));

import LoginPage from "@/pages/LoginPage";

function renderWithRouter() {
  return render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );
}

describe("LoginPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthStore.isAuthenticated = false;
    mockAuthStore.error = null;
  });

  it("渲染页面标题和副标题", () => {
    renderWithRouter();
    expect(screen.getByText("登录")).toBeInTheDocument();
    expect(screen.getByText("登录账号以使用获授权的云端服务；本机模型和自购 API 无需登录")).toBeInTheDocument();
  });

  it("渲染注册申请链接", () => {
    renderWithRouter();
    expect(screen.getByText("申请注册")).toBeInTheDocument();
  });

  it("渲染 LoginForm 组件", () => {
    renderWithRouter();
    expect(screen.getByTestId("login-form")).toBeInTheDocument();
  });

  it("store 中有 error 时显示错误信息", () => {
    mockAuthStore.error = "用户名或密码错误";
    renderWithRouter();
    expect(screen.getByText("用户名或密码错误")).toBeInTheDocument();
  });

  it("store 中无 error 时不显示错误区域", () => {
    renderWithRouter();
    expect(screen.queryByText(/错误/)).not.toBeInTheDocument();
  });

  it("登录成功时导航到 /documents", async () => {
    const user = userEvent.setup();
    renderWithRouter();
    await user.click(screen.getByTestId("login-success-btn"));
    expect(mockNavigate).toHaveBeenCalledWith("/documents", { replace: true });
  });

  it("已登录时自动重定向到 /documents", () => {
    mockAuthStore.isAuthenticated = true;
    renderWithRouter();
    // useEffect 触发 navigate
    expect(mockNavigate).toHaveBeenCalledWith("/documents", { replace: true });
  });
});
