import { getAccountServer } from '@/services/accountServer';
/**
 * WebSocket 实时通知 Hook（E1-04）
 *
 * 作用：
 *   建立 WebSocket 连接，接收后端推送的实时通知（审批结果、文档处理完成等），
 *   并通过 Toast Store 显示给用户。支持自动重连和登出时断开。
 *
 * 实现方式：
 *   1. 从 authStore 获取 access_token，从 getAccountServer() 推导 WebSocket URL
 *   2. 仅在用户已认证时建立连接
 *   3. 连接断开后按指数退避策略自动重连（1s → 2s → 4s → ... 最大 30s）
 *   4. 收到消息后按 type 字段映射到对应 Toast 类型
 *   5. 组件卸载或登出时关闭连接
 *
 * 使用方式：
 *   // 在顶层组件（如 App.tsx）调用一次即可全局生效
 *   import { useNotification } from "@/hooks/useNotification";
 *   function App() {
 *     useNotification();
 *     return <Routes>...</Routes>;
 *   }
 *
 * 通知消息格式（后端 → 前端）：
 *   {
 *     "type": "registration_approved" | "registration_rejected" |
 *             "document_completed" | "document_failed" | "system",
 *     "message": "通知正文",
 *     "timestamp": "2026-07-11T10:00:00Z"
 *   }
 */

import { useEffect, useRef } from "react";
import { TOKEN_STORAGE_KEY } from "@/utils/constants";
import { useAuthStore } from "@/store/authStore";
import { useToastStore } from "@/store/toastStore";

/** 通知类型 → Toast 类型映射 */
const NOTIFICATION_TYPE_MAP: Record<string, "success" | "error" | "warning" | "info"> = {
  registration_approved: "success",
  registration_rejected: "error",
  document_completed: "success",
  document_failed: "error",
  system: "info",
};

/** 通知类型 → 默认标题映射 */
const NOTIFICATION_TITLE_MAP: Record<string, string> = {
  registration_approved: "注册申请已通过",
  registration_rejected: "注册申请未通过",
  document_completed: "文档处理完成",
  document_failed: "文档处理失败",
  system: "系统通知",
};

/** 最大重连间隔（毫秒） */
const MAX_RECONNECT_DELAY = 30_000;
/** 初始重连间隔（毫秒） */
const INITIAL_RECONNECT_DELAY = 1_000;

/**
 * 从 getAccountServer() 推导 WebSocket URL
 *
 * 作用：
 *   将 http://localhost:8000/api/v1 转换为 ws://localhost:8000/ws/notifications
 *   将 https://api.example.com/api/v1 转换为 wss://api.example.com/ws/notifications
 *
 * 实现方式：
 *   1. 替换协议（http→ws, https→wss）
 *   2. 移除 /api/v1 后缀（WebSocket 端点不在 API 前缀下）
 *   3. 拼接 /ws/notifications 路径
 *
 * 参数：
 *   apiUrl - API 基础 URL（如 http://localhost:8000/api/v1）
 *
 * 返回：
 *   WebSocket URL（如 ws://localhost:8000/ws/notifications）
 */
function buildWebSocketUrl(apiUrl: string): string {
  // 替换协议：http→ws, https→wss
  const wsOrigin = apiUrl
    .replace(/^https:\/\//, "wss://")
    .replace(/^http:\/\//, "ws://");

  // 移除 /api/v1 后缀（如有）
  const baseUrl = wsOrigin.replace(/\/api\/v\d+\/?$/, "");

  return `${baseUrl}/ws/notifications`;
}

/**
 * 从 localStorage 读取最新的 access_token
 *
 * 作用：
 *   直接从 localStorage 读取 token，避免依赖 authStore 的响应式更新触发重连。
 *   authStore.tokens 在页面刷新后通过 restoreSession() 恢复，但 hook 初始化时
 *   可能尚未完成。直接读 localStorage 确保获取到最新值。
 *
 * 返回：
 *   access_token 字符串或 null（未登录时）
 */
function getAccessToken(): string | null {
  try {
    const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!raw) return null;
    const tokens = JSON.parse(raw);
    return tokens?.access_token ?? null;
  } catch {
    return null;
  }
}

/**
 * WebSocket 实时通知 Hook
 *
 * 作用：
 *   在组件挂载时建立 WebSocket 连接，接收后端推送的实时通知。
 *   仅在用户已认证时连接，登出或组件卸载时自动断开。
 *
 * 使用方式：
 *   function App() {
 *     useNotification();
 *     return <Routes>...</Routes>;
 *   }
 */
export function useNotification(): void {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef<number>(INITIAL_RECONNECT_DELAY);
  const isManualCloseRef = useRef<boolean>(false);

  useEffect(() => {
    // 未认证时不建立连接
    if (!isAuthenticated) {
      return;
    }

    const token = getAccessToken();
    if (!token) {
      return;
    }

    isManualCloseRef.current = false;

    /**
     * 建立 WebSocket 连接
     *
     * 作用：
     *   创建 WebSocket 实例，绑定 onmessage/onclose/onerror 事件处理器。
     *   连接断开时按指数退避策略自动重连。
     */
    const connect = (): void => {
      const wsUrl = buildWebSocketUrl(getAccountServer());
      const url = `${wsUrl}?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      // 收到消息时显示 Toast 通知
      ws.onmessage = (event: MessageEvent) => {
        try {
          const notification = JSON.parse(event.data);
          const type = notification?.type ?? "system";
          const message = notification?.message ?? "";
          const toastType = NOTIFICATION_TYPE_MAP[type] ?? "info";
          const title = NOTIFICATION_TITLE_MAP[type] ?? "通知";

          // 通过 Toast Store 显示通知
          const { addToast } = useToastStore.getState();
          addToast({
            type: toastType,
            title,
            description: message,
            duration: 6000,
          });
        } catch {
          // JSON 解析失败，忽略无效消息
        }
      };

      // 连接关闭时自动重连（非手动关闭情况）
      ws.onclose = () => {
        wsRef.current = null;

        // 手动关闭（组件卸载/登出）时不重连
        if (isManualCloseRef.current) {
          return;
        }

        // 指数退避重连：1s → 2s → 4s → 8s → 16s → 30s
        const delay = Math.min(
          reconnectDelayRef.current,
          MAX_RECONNECT_DELAY
        );
        reconnectTimerRef.current = setTimeout(() => {
          reconnectDelayRef.current = Math.min(
            reconnectDelayRef.current * 2,
            MAX_RECONNECT_DELAY
          );
          connect();
        }, delay);
      };

      // 连接成功时重置重连延迟
      ws.onopen = () => {
        reconnectDelayRef.current = INITIAL_RECONNECT_DELAY;
      };

      // 错误事件（onclose 会随后触发，重连逻辑在 onclose 中处理）
      ws.onerror = () => {
        // 错误处理由 onclose 接管，此处无需额外操作
      };
    };

    connect();

    // 清理函数：组件卸载或 isAuthenticated 变为 false 时执行
    return () => {
      isManualCloseRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [isAuthenticated]);
}
