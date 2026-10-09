/**
 * auth API 单元测试
 *
 * 覆盖范围：
 *   - 真实 API 函数：login, refreshToken, logout, getCurrentUser, register
 *     （mock apiClient 验证调用参数和返回值）
 *   - 注册审批流程：submitRegisterApply, getApplicationStatus, setPassword
 *     （mock apiClient 验证后端 API 调用参数和返回值）
 *   - 管理员函数：listApplications, approveApplication, rejectApplication
 *     （mock apiClient 验证调用参数和返回值）
 *
 * Mock 策略：mock @/api/client 的 apiClient
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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
  registerTokenExpiredCallback: vi.fn(),
  clearTokens: vi.fn(),
  getStoredTokens: vi.fn(() => null),
  storeTokens: vi.fn(),
  HttpClientError: class HttpClientError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

import {
  login,
  refreshToken,
  logout,
  getCurrentUser,
  register,
  submitRegisterApply,
  getApplicationStatus,
  setPassword,
  listApplications,
  approveApplication,
  rejectApplication,
} from "../auth";

describe("auth API - 真实接口", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("login - 调用 POST /auth/login", async () => {
    const mockResponse = {
      access_token: "token-123",
      refresh_token: "refresh-123",
      token_type: "bearer",
      user: { id: 1, username: "test", email: "test@example.com", role: "user" },
    };
    mockApiClient.post.mockResolvedValueOnce(mockResponse);
    const result = await login({ username: "test@example.com", password: "pass123" });
    expect(mockApiClient.post).toHaveBeenCalledWith("/auth/login", {
      username: "test@example.com",
      password: "pass123",
    }, { auth: false, autoRefresh: false });
    expect(result).toEqual(mockResponse);
  });

  it("refreshToken - 调用 POST /auth/refresh", async () => {
    const mockResponse = {
      access_token: "new-token",
      refresh_token: "new-refresh",
      token_type: "bearer",
    };
    mockApiClient.post.mockResolvedValueOnce(mockResponse);
    const result = await refreshToken("old-refresh-token");
    expect(mockApiClient.post).toHaveBeenCalledWith("/auth/refresh", {
      refresh_token: "old-refresh-token",
    });
    expect(result).toEqual(mockResponse);
  });

  it("logout - 调用 POST /auth/logout", async () => {
    mockApiClient.post.mockResolvedValueOnce(undefined);
    await logout();
    expect(mockApiClient.post).toHaveBeenCalledWith("/auth/logout");
  });

  it("getCurrentUser - 调用 GET /auth/me", async () => {
    const mockUser = { id: 1, username: "test", email: "test@example.com", role: "user" };
    mockApiClient.get.mockResolvedValueOnce(mockUser);
    const result = await getCurrentUser();
    expect(mockApiClient.get).toHaveBeenCalledWith("/auth/me");
    expect(result).toEqual(mockUser);
  });

  it("register - 调用 POST /auth/register", async () => {
    const mockUser = { id: 2, username: "newuser", email: "new@example.com", role: "user" };
    mockApiClient.post.mockResolvedValueOnce(mockUser);
    const result = await register({
      username: "newuser",
      email: "new@example.com",
      password: "pass1234",
    });
    expect(mockApiClient.post).toHaveBeenCalledWith("/auth/register", {
      username: "newuser",
      email: "new@example.com",
      password: "pass1234",
    });
    expect(result).toEqual(mockUser);
  });
});

describe("auth API - 注册申请流程（真实后端接口）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submitRegisterApply - 调用 POST /auth/register/apply", async () => {
    const mockResponse = {
      application_id: 42,
      status: "pending" as const,
      message: "注册申请已提交，请等待管理员审核",
    };
    mockApiClient.post.mockResolvedValueOnce(mockResponse);
    const result = await submitRegisterApply({
      email: "test@example.com",
      username: "testuser",
    });
    expect(mockApiClient.post).toHaveBeenCalledWith("/auth/register/apply", {
      email: "test@example.com",
      username: "testuser",
    });
    expect(result).toEqual(mockResponse);
    expect(result.application_id).toBe(42);
    expect(result.status).toBe("pending");
  });

  it("getApplicationStatus - 调用 GET /auth/register/status?email=xxx", async () => {
    const mockResponse = {
      status: "pending" as const,
      email: "test@example.com",
      username: "testuser",
      submitted_at: "2026-07-10T10:00:00Z",
      reviewed_at: null,
      reject_reason: null,
    };
    mockApiClient.get.mockResolvedValueOnce(mockResponse);
    const result = await getApplicationStatus("test@example.com");
    // 邮箱应被 URL 编码
    expect(mockApiClient.get).toHaveBeenCalledWith(
      "/auth/register/status?email=test%40example.com",
    );
    expect(result).toEqual(mockResponse);
    expect(result.status).toBe("pending");
    expect(result.reviewed_at).toBeNull();
  });

  it("getApplicationStatus - 特殊字符邮箱正确编码", async () => {
    const mockResponse = {
      status: "approved" as const,
      email: "user+tag@example.com",
      username: "usertag",
      submitted_at: "2026-07-10T10:00:00Z",
      reviewed_at: "2026-07-10T12:00:00Z",
      reject_reason: null,
    };
    mockApiClient.get.mockResolvedValueOnce(mockResponse);
    await getApplicationStatus("user+tag@example.com");
    // + 号应被编码为 %2B
    expect(mockApiClient.get).toHaveBeenCalledWith(
      "/auth/register/status?email=user%2Btag%40example.com",
    );
  });

  it("setPassword - 调用 POST /auth/set-password", async () => {
    const mockResponse = {
      success: true,
      message: "密码设置成功，您现在可以登录了",
    };
    mockApiClient.post.mockResolvedValueOnce(mockResponse);
    const result = await setPassword({
      token: "valid-token-12345",
      password: "newpass123",
    });
    expect(mockApiClient.post).toHaveBeenCalledWith("/auth/set-password", {
      token: "valid-token-12345",
      password: "newpass123",
    });
    expect(result).toEqual(mockResponse);
    expect(result.success).toBe(true);
  });
});

describe("auth API - 管理员函数", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("listApplications - 无参数时调用 GET /auth/register/applications", async () => {
    const mockResponse = {
      items: [],
      total: 0,
      pending_count: 0,
    };
    mockApiClient.get.mockResolvedValueOnce(mockResponse);
    const result = await listApplications();
    expect(mockApiClient.get).toHaveBeenCalledWith("/auth/register/applications");
    expect(result).toEqual(mockResponse);
  });

  it("listApplications - 带状态和分页参数时正确拼接查询字符串", async () => {
    const mockResponse = {
      items: [
        {
          id: 1,
          email: "a@example.com",
          username: "userA",
          status: "pending" as const,
          submitted_at: "2026-07-10T10:00:00Z",
          reviewed_at: null,
          reviewed_by: null,
          reject_reason: null,
        },
      ],
      total: 1,
      pending_count: 1,
    };
    mockApiClient.get.mockResolvedValueOnce(mockResponse);
    const result = await listApplications({ status: "pending", page: 1, page_size: 20 });
    // 验证查询参数拼接
    expect(mockApiClient.get).toHaveBeenCalledWith(
      "/auth/register/applications?status=pending&page=1&page_size=20",
    );
    expect(result.total).toBe(1);
    expect(result.items[0].email).toBe("a@example.com");
  });

  it("approveApplication - 调用 POST /auth/register/approve", async () => {
    const mockResponse = { message: "已批准申请，密码设置邮件已发送" };
    mockApiClient.post.mockResolvedValueOnce(mockResponse);
    const result = await approveApplication(42);
    expect(mockApiClient.post).toHaveBeenCalledWith("/auth/register/approve", {
      application_id: 42,
    });
    expect(result).toEqual(mockResponse);
  });

  it("rejectApplication - 调用 POST /auth/register/reject", async () => {
    const mockResponse = { message: "已拒绝申请，通知邮件已发送" };
    mockApiClient.post.mockResolvedValueOnce(mockResponse);
    const result = await rejectApplication(42, "信息不完整");
    expect(mockApiClient.post).toHaveBeenCalledWith("/auth/register/reject", {
      application_id: 42,
      reject_reason: "信息不完整",
    });
    expect(result).toEqual(mockResponse);
  });
});
