/**
 * authStore 单元测试
 *
 * 覆盖范围：
 *   - login：登录成功/失败
 *   - logout：登出清除状态
 *   - restoreSession：从 localStorage 恢复
 *   - clearError：清除错误
 *
 * 策略：仅 mock @/api/client 层（apiClient），让真实 authApi 调用 mock 的 HTTP 层
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock @/api/client — 让真实 authApi 通过 mock 的 apiClient 通信
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
  getStoredTokens: vi.fn(() => { const raw = localStorage.getItem('kb_auth_tokens'); return raw ? JSON.parse(raw) : null; }),
  storeTokens: vi.fn(tokens => localStorage.setItem('kb_auth_tokens', JSON.stringify(tokens))),
  HttpClientError: class HttpClientError extends Error {
    status: number;
    detail: unknown;
    constructor(status: number, detail: unknown) {
      super(`HTTP ${status}`);
      this.status = status;
      this.detail = detail;
    }
  },
}));

import { useAuthStore } from "@/store/authStore";
import type { TokenResponse } from "@/types/user";

/** 创建测试用 Token */
function createMockToken(): TokenResponse {
  return {
    access_token: "access_token_123",
    refresh_token: "refresh_token_456",
    token_type: "bearer",
    expires_in: 3600,
    user: {
      id: 1,
      username: "testuser",
      email: "test@example.com",
      is_active: true,
      is_superuser: false,
      created_at: "2026-01-01T00:00:00Z",
      user_type: "regular",
    },
  };
}

describe("authStore", () => {
  beforeEach(() => {
    // 重置 store
    useAuthStore.setState({
      user: null,
      tokens: null,
      isAuthenticated: false,
      loading: false,
      error: null,
    });
    localStorage.clear();
    vi.clearAllMocks();
  });

  describe("login", () => {
    it("登录成功 - 设置用户和 Token", async () => {
      const mockToken = createMockToken();
      mockApiClient.post.mockResolvedValueOnce(mockToken);

      const { login } = useAuthStore.getState();
      await login({ username: "test@example.com", password: "password123" });

      const state = useAuthStore.getState();
      expect(state.isAuthenticated).toBe(true);
      expect(state.user).toEqual(mockToken.user);
      expect(state.tokens).toEqual(mockToken);
      expect(state.loading).toBe(false);
      expect(state.error).toBeNull();
    });

    it("登录失败 - 设置错误状态", async () => {
      mockApiClient.post.mockRejectedValueOnce(new Error("用户名或密码错误"));

      const { login } = useAuthStore.getState();
      // login 失败时会 re-throw，需捕获后验证状态
      await expect(
        login({ username: "wrong@example.com", password: "wrong" }),
      ).rejects.toThrow("用户名或密码错误");

      const state = useAuthStore.getState();
      expect(state.isAuthenticated).toBe(false);
      expect(state.user).toBeNull();
      expect(state.tokens).toBeNull();
      expect(state.error).toBe("用户名或密码错误");
      expect(state.loading).toBe(false);
    });

    it("登录时设置 loading 状态", async () => {
      const mockToken = createMockToken();
      mockApiClient.post.mockResolvedValueOnce(mockToken);

      const { login } = useAuthStore.getState();
      const promise = login({ username: "test@example.com", password: "password123" });

      expect(useAuthStore.getState().loading).toBe(true);

      await promise;

      expect(useAuthStore.getState().loading).toBe(false);
    });
  });

  describe("logout", () => {
    it("登出 - 清除认证状态", async () => {
      const mockToken = createMockToken();
      useAuthStore.setState({
        user: mockToken.user,
        tokens: mockToken,
        isAuthenticated: true,
      });

      mockApiClient.post.mockResolvedValueOnce(undefined);

      const { logout } = useAuthStore.getState();
      await logout();

      const state = useAuthStore.getState();
      expect(state.isAuthenticated).toBe(false);
      expect(state.user).toBeNull();
      expect(state.tokens).toBeNull();
    });

    it("登出失败也清除本地状态（保证 UI 一致性）", async () => {
      const mockToken = createMockToken();
      useAuthStore.setState({
        user: mockToken.user,
        tokens: mockToken,
        isAuthenticated: true,
      });

      mockApiClient.post.mockRejectedValueOnce(new Error("网络错误"));

      const { logout } = useAuthStore.getState();
      await logout();

      const state = useAuthStore.getState();
      expect(state.isAuthenticated).toBe(false);
      expect(state.user).toBeNull();
    });
  });

  describe("clearError", () => {
    it("清除错误状态", () => {
      useAuthStore.setState({ error: "测试错误" });
      const { clearError } = useAuthStore.getState();
      clearError();
      expect(useAuthStore.getState().error).toBeNull();
    });
  });

  describe("restoreSession", () => {
    it("无 Token 时不恢复", () => {
      const { restoreSession } = useAuthStore.getState();
      restoreSession();

      const state = useAuthStore.getState();
      expect(state.isAuthenticated).toBe(false);
      expect(state.user).toBeNull();
    });

    it("有 Token 时恢复认证状态", () => {
      const mockToken = createMockToken();
      localStorage.setItem("kb_auth_tokens", JSON.stringify(mockToken));
      localStorage.setItem("kb_auth_user", JSON.stringify(mockToken.user));

      const { restoreSession } = useAuthStore.getState();
      restoreSession();

      const state = useAuthStore.getState();
      expect(state.isAuthenticated).toBe(true);
      expect(state.user).toEqual(mockToken.user);
      expect(state.tokens).toEqual(mockToken);
    });
  });
});
