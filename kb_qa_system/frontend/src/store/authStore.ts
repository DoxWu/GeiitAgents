import { getAccountGeneration, getAccountServer, subscribeAccountServer } from '@/services/accountServer';
import { finishLoginDiagnostic, type LoginDiagnostic } from '@/services/loginDiagnostics';
/**
 * 认证状态管理 Store
 *
 * 作用：
 *   使用 Zustand 管理用户认证状态，包括：
 *   - 当前登录用户信息
 *   - Token 存储与持久化
 *   - 登录/登出操作
 *   - 应用启动时从 localStorage 恢复会话
 *
 * 使用方式：
 *   import { useAuthStore } from '@/store/authStore';
 *   const { user, login, logout } = useAuthStore();
 */

import { create } from "zustand";
import * as authApi from "@/api/auth";
import {
  clearTokens,
  storeTokens,
  getStoredTokens,
  registerTokenExpiredCallback,
} from "@/api/client";
import { USER_STORAGE_KEY } from "@/utils/constants";
import { safeStorage } from "@/utils/safeStorage";
import type { TokenResponse, UserResponse, LoginRequest } from "@/types/user";
import { useDocumentStore } from "@/store/documentStore";

/** 认证 Store 状态接口 */
interface AuthState {
  /** 当前用户信息（null 表示未登录） */
  user: UserResponse | null;
  /** Token 信息 */
  tokens: TokenResponse | null;
  /** 是否已认证 */
  isAuthenticated: boolean;
  /** 是否正在加载（登录/初始化中） */
  loading: boolean;
  /** 错误信息 */
  error: string | null;
  loginDiagnostic: LoginDiagnostic | null;

  /** 登录 */
  login: (data: LoginRequest) => Promise<void>;
  /** 游客登录（临时账号，权限受限） */
  guestLogin: () => Promise<void>;
  /** 登出 */
  logout: () => Promise<void>;
  /** 删除账号（GDPR/PIPL 合规） */
  deleteAccount: (password: string) => Promise<void>;
  /** 从 localStorage 恢复会话 */
  restoreSession: () => void;
  /** 清除错误 */
  clearError: () => void;
}

/**
 * 从 localStorage 恢复 Token 和用户信息
 * @returns Token 和用户信息
 */
function restoreFromStorage(): {
  tokens: TokenResponse | null;
  user: UserResponse | null;
} {
  try {
    const tokensRaw = getStoredTokens();
    const userRaw = safeStorage.getItem(USER_STORAGE_KEY);
    const tokens = tokensRaw;
    const user = userRaw ? (JSON.parse(userRaw) as UserResponse) : null;
    return { tokens, user };
  } catch {
    return { tokens: null, user: null };
  }
}

/** 认证 Store */
export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  tokens: null,
  isAuthenticated: false,
  loading: false,
  error: null,
  loginDiagnostic: null,

  login: async (data: LoginRequest) => {
    const generation = getAccountGeneration();
    const attempt: LoginDiagnostic = { phase: 'sending', url: `${getAccountServer()}/auth/login`, startedAt: new Date().toISOString() };
    const controller = new AbortController(); let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 20_000);
    set({ loading: true, error: null, loginDiagnostic: attempt });
    try {
      const tokenResponse = await authApi.login(data, controller.signal);
      if (generation !== getAccountGeneration()) throw new DOMException('账号服务器已切换', 'AbortError');

      // 修复问题三：登录前清除前一个用户的文档数据，防止数据残留。
      // 作用：覆盖 token 过期后直接登录新账户的场景（logout 未被调用，
      //   documentStore 中仍残留前一个用户的 folders/documents）。
      //   在设置新用户状态之前调用，确保新会话从干净状态开始。
      useDocumentStore.getState().reset();

      // 持久化到安全存储（兼容国产浏览器的 localStorage 降级）
      storeTokens(tokenResponse);
      safeStorage.setItem(
        USER_STORAGE_KEY,
        JSON.stringify(tokenResponse.user),
      );

      set({
        user: tokenResponse.user,
        tokens: tokenResponse,
        isAuthenticated: true,
        loading: false,
        error: null,
        loginDiagnostic: finishLoginDiagnostic(attempt),
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "登录失败，请重试";
      if (generation !== getAccountGeneration()) throw err;
      set({ loading: false, error: timedOut ? '登录请求超时，请检查服务器地址和网络后重试。' : message, loginDiagnostic: finishLoginDiagnostic(attempt, err, timedOut) });
      throw err;
    } finally { clearTimeout(timeout); }
  },

  guestLogin: async () => {
    const generation = getAccountGeneration();
    const attempt: LoginDiagnostic = { phase: 'sending', url: `${getAccountServer()}/auth/guest-login`, startedAt: new Date().toISOString() };
    const controller = new AbortController(); let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 20_000);
    set({ loading: true, error: null, loginDiagnostic: attempt });
    try {
      const tokenResponse = await authApi.guestLogin(controller.signal);
      if (generation !== getAccountGeneration()) throw new DOMException('账号服务器已切换', 'AbortError');

      // 修复问题三：登录前清除前一个用户的文档数据（与 login 一致）
      useDocumentStore.getState().reset();

      // 持久化到安全存储（与 login 一致）
      storeTokens(tokenResponse);
      safeStorage.setItem(
        USER_STORAGE_KEY,
        JSON.stringify(tokenResponse.user),
      );

      set({
        user: tokenResponse.user,
        tokens: tokenResponse,
        isAuthenticated: true,
        loading: false,
        error: null,
        loginDiagnostic: finishLoginDiagnostic(attempt),
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "游客登录失败，请重试";
      if (generation !== getAccountGeneration()) throw err;
      set({ loading: false, error: timedOut ? '登录请求超时，请检查服务器地址和网络后重试。' : message, loginDiagnostic: finishLoginDiagnostic(attempt, err, timedOut) });
      throw err;
    } finally { clearTimeout(timeout); }
  },

  logout: async () => {
    const generation = getAccountGeneration();
    try {
      // 尝试通知后端登出（失败不阻塞）
      await authApi.logout();
    } catch {
      // 忽略登出请求失败
    } finally {
      if (generation === getAccountGeneration()) {
      // 修复问题3：登出时重置 documentStore，清除前一个用户的分支/文档数据，
      // 防止切换账户后数据残留（如普通账户→游客→换回时分支丢失或看到他人分支）
      useDocumentStore.getState().reset();
      clearTokens();
      safeStorage.removeItem(USER_STORAGE_KEY);
      set({
        user: null,
        tokens: null,
        isAuthenticated: false,
        error: null,
      });
      }
    }
  },

  deleteAccount: async (password: string) => {
    const generation = getAccountGeneration();
    set({ loading: true, error: null });
    try {
      // 获取当前 Refresh Token，一并吊销
      const tokens = getStoredTokens();
      const refreshToken = tokens?.refresh_token;

      // 调用删除账号 API（后端会删除数据并吊销 Token）
      await authApi.deleteAccount(password, refreshToken);
      if (generation !== getAccountGeneration()) throw new DOMException('账号服务器已切换', 'AbortError');

      // 清除本地状态（不调用 logout API，避免重复黑名单请求）
      useDocumentStore.getState().reset();
      clearTokens();
      safeStorage.removeItem(USER_STORAGE_KEY);
      set({
        user: null,
        tokens: null,
        isAuthenticated: false,
        loading: false,
        error: null,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "删除账号失败，请重试";
      if (generation !== getAccountGeneration()) throw err;
      set({ loading: false, error: message });
      throw err;
    }
  },

  restoreSession: () => {
    const { tokens, user } = restoreFromStorage();
    if (tokens && user) {
      set({
        tokens,
        user,
        isAuthenticated: true,
      });
    }
  },

  clearError: () => set({ error: null }),
}));

/**
 * 注册 Token 过期回调
 * 作用：当 Token 刷新失败时，清除认证状态，触发路由守卫跳转登录页
 */
registerTokenExpiredCallback(() => {
  safeStorage.removeItem(USER_STORAGE_KEY);
  useDocumentStore.getState().reset();
  useAuthStore.setState({
    user: null,
    tokens: null,
    isAuthenticated: false,
    error: "登录已过期，请重新登录",
  });
});

/**
 * 模块加载时同步恢复会话
 * 作用：从 localStorage 读取已保存的 Token 和用户信息，
 *       确保路由守卫在首次渲染时即可正确判断认证状态，避免登录页闪烁。
 */
useAuthStore.getState().restoreSession();

subscribeAccountServer(() => {
  useDocumentStore.getState().reset();
  useAuthStore.setState({ user: null, tokens: null, isAuthenticated: false, loading: false, error: null, loginDiagnostic: null });
});
