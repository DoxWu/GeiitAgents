import { getAccountServer, accountFetch, getAccountGeneration, getAccountSignal } from '@/services/accountServer';
/**
 * API 客户端核心封装
 *
 * 作用：
 *   统一管理 HTTP 请求，提供以下能力：
 *   - 请求/响应拦截
 *   - Token 自动注入
 *   - 401 时自动刷新 Token 并重试
 *   - 统一错误处理
 *   - 上传进度支持（基于 XMLHttpRequest）
 *
 * 使用方式：
 *   import { apiClient } from '@/api/client';
 *   const data = await apiClient.get<UserResponse>('/auth/me');
 */

import { TOKEN_STORAGE_KEY } from "@/utils/constants";
import { safeStorage } from "@/utils/safeStorage";
import type { TokenResponse, RefreshTokenResponse } from "@/types/user";
import type { ApiError, RequestOptions } from "@/types/api";

/** 自定义错误类，携带 HTTP 状态码和错误详情 */
export class HttpClientError extends Error {
  requestId?: string;
  /** HTTP 状态码 */
  status: number;
  /** 原始错误响应 */
  detail: ApiError["detail"];

  constructor(status: number, detail: ApiError["detail"], message?: string) {
    super(message || `HTTP ${status}`);
    this.name = "HttpClientError";
    this.status = status;
    this.detail = detail;
  }
}

/** Token 刷新状态（防止并发刷新） */
let refreshGeneration = -1;
let refreshPromise: Promise<string | null> | null = null;

/**
 * 从 localStorage 读取存储的 Token
 * @returns Token 响应对象或 null
 */
export function getStoredTokens(): TokenResponse | null {
  try {
    const owner = safeStorage.getItem("kb_auth_server");
    if (owner && owner !== getAccountServer()) return null;
    const raw = safeStorage.getItem(TOKEN_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as TokenResponse) : null;
  } catch {
    return null;
  }
}

/**
 * 保存 Token 到 localStorage
 * @param tokens - Token 响应对象
 */
export function storeTokens(tokens: TokenResponse): void {
  safeStorage.setItem("kb_auth_server", getAccountServer());
  safeStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(tokens));
}

/**
 * 更新部分 Token（刷新后使用）
 * @param refreshResponse - 刷新响应
 */
export function updateTokens(refreshResponse: RefreshTokenResponse): void {
  const existing = getStoredTokens();
  if (existing) {
    const updated: TokenResponse = {
      ...existing,
      access_token: refreshResponse.access_token,
      refresh_token: refreshResponse.refresh_token,
      expires_in: refreshResponse.expires_in,
      token_type: refreshResponse.token_type,
    };
    storeTokens(updated);
  }
}

/** 清除 Token（登出或刷新失败时调用） */
export function clearTokens(): void {
  safeStorage.removeItem(TOKEN_STORAGE_KEY);
}

/** Token 过期回调（由 authStore 注册，用于跳转登录） */
let onTokenExpired: (() => void) | null = null;

/**
 * 注册 Token 过期回调
 * @param callback - Token 过期时的回调函数
 */
export function registerTokenExpiredCallback(callback: () => void): void {
  onTokenExpired = callback;
}

/**
 * 使用 Refresh Token 刷新 Access Token
 *
 * 作用：
 *   当 Access Token 过期（401）时，自动用 Refresh Token 换取新 Token。
 *   使用 promise 缓存防止并发请求同时触发多次刷新。
 *
 * @returns 新的 Access Token 或 null（刷新失败）
 */
export async function refreshAccessToken(): Promise<string | null> {
  // 如果已有刷新请求在进行，复用该 promise
  if (refreshPromise && refreshGeneration === getAccountGeneration()) return refreshPromise;
  refreshGeneration = getAccountGeneration();

  const tokens = getStoredTokens();
  if (!tokens?.refresh_token) return null;

  const generation = getAccountGeneration();
  refreshPromise = (async () => {
    try {
      const res = await accountFetch(`${getAccountServer()}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: tokens.refresh_token }),
      });

      if (generation !== getAccountGeneration()) return null;
      if (!res.ok) {
        // 刷新失败，清除 Token
        clearTokens();
        onTokenExpired?.();
        return null;
      }

      const data: RefreshTokenResponse = await res.json();
      if (generation !== getAccountGeneration()) return null;
      updateTokens(data);
      return data.access_token;
    } catch {
      if (generation !== getAccountGeneration()) return null;
      clearTokens();
      onTokenExpired?.();
      return null;
    } finally {
      if (generation === getAccountGeneration()) refreshPromise = null;
    }
  })();

  return refreshPromise;
}

/**
 * 构建请求 headers
 * @param options - 请求选项
 * @returns headers 对象
 */
function buildHeaders(options: RequestOptions): HeadersInit {
  const headers: Record<string, string> = {};

  // 非 FormData 请求设置 Content-Type
  if (!(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }

  // 需要认证时注入 Token
  const needAuth = options.auth !== false;
  if (needAuth) {
    const tokens = getStoredTokens();
    if (tokens?.access_token) {
      headers["Authorization"] = `Bearer ${tokens.access_token}`;
    }
  }

  // 合并用户自定义 headers
  if (options.headers) {
    const userHeaders =
      options.headers instanceof Headers
        ? Object.fromEntries(options.headers.entries())
        : (options.headers as Record<string, string>);
    Object.assign(headers, userHeaders);
  }

  return headers;
}

/**
 * 解析错误响应
 * @param res - fetch Response 对象
 * @returns HttpClientError
 */
async function parseError(res: Response): Promise<HttpClientError> {
  let detail: ApiError["detail"] = res.statusText;
  let message = `HTTP ${res.status}`;

  try {
    const body: ApiError = await res.json();
    detail = body.detail;
    if (typeof body.detail === "string") {
      message = body.detail;
    } else if (Array.isArray(body.detail) && body.detail.length > 0) {
      message = body.detail[0]?.msg || message;
    }
  } catch {
    // 响应非 JSON，使用状态文本
  }

  const error = new HttpClientError(res.status, detail, message);
  const requestId = res.headers?.get('X-Request-ID');
  if (requestId && /^[A-Za-z0-9._:-]{1,100}$/.test(requestId)) error.requestId = requestId;
  return error;
}

/**
 * 网络错误友好提示
 * 作用：fetch 在网络不可达、CORS 被拒、DNS 解析失败时抛出 TypeError，
 *       原始消息为英文 "Failed to fetch"，对中文用户不友好。
 *       此函数将原始 TypeError 转换为带中文提示的 Error。
 *
 * 触发场景：
 *   - 用户在中国大陆访问海外服务器（如 Railway），网络不通
 *   - 服务器暂时不可用（部署中、崩溃）
 *   - CORS 预检失败
 *   - 夸克/QQ/UC 等浏览器内核兼容性问题导致连接失败
 *
 * @param err - 原始错误对象
 * @returns 转换后的 Error（非网络错误原样返回）
 */
function toFriendlyNetworkError(err: unknown): Error {
  if (err instanceof TypeError) {
    const msg = err.message.toLowerCase();
    if (msg.includes("failed to fetch") || msg.includes("networkerror") || msg.includes("load failed")) {
      return new Error(getNetworkErrorMessage());
    }
  }
  return err as Error;
}

/**
 * 获取网络错误消息（含浏览器兼容性提示）
 *
 * 作用：
 *   根据 userAgent 检测浏览器类型，对夸克/QQ/UC 等国产浏览器
 *   返回含更换浏览器建议的错误消息。
 *
 * @returns 友好的中文错误消息
 */
function getNetworkErrorMessage(): string {
  const ua = navigator.userAgent.toLowerCase();
  // 国产浏览器兼容性检测
  // 作用：这些浏览器在处理跨域请求、SSE、WebSocket 时可能行为不一致，
  //       导致连接服务器失败。检测到时提示用户更换浏览器。
  const isQuark = ua.includes("quark");
  const isQQ = ua.includes("qqbrowser") || (ua.includes("qq") && !ua.includes("edge"));
  const isUC = ua.includes("ucbrowser") || ua.includes("ubrowser");
  const isBaidu = ua.includes("baidu") || ua.includes("bdbrowser");
  const isSogou = ua.includes("sogou");
  const isLiebao = ua.includes("liebao") || ua.includes("lbbrowser");

  if (isQuark || isQQ || isUC || isBaidu || isSogou || isLiebao) {
    return "网络连接失败，无法访问服务器。您当前使用的浏览器可能存在兼容性问题，建议更换为 Chrome、Edge 或 Firefox 等主流浏览器后重试。";
  }
  return "网络连接失败，无法访问服务器。如果您在中国大陆访问，可能需要使用代理或 VPN。请检查网络连接后重试。";
}

/** API 客户端接口定义 */
interface ApiClient {
  /** 发送 HTTP 请求 */
  request<T>(endpoint: string, options?: RequestOptions): Promise<T>;
  /** GET 请求 */
  get<T>(endpoint: string, options?: RequestOptions): Promise<T>;
  /** GET 请求（返回纯文本，用于文档预览等非 JSON 响应） */
  getText(endpoint: string, options?: RequestOptions): Promise<string>;
  /** GET 请求（返回 Blob，用于 PDF iframe 等二进制响应） */
  getBlob(endpoint: string, options?: RequestOptions): Promise<Blob>;
  /** POST 请求 */
  post<T>(
    endpoint: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<T>;
  /** PATCH 请求 */
  patch<T>(
    endpoint: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<T>;
  /** DELETE 请求 */
  delete<T>(endpoint: string, options?: RequestOptions): Promise<T>;
  /** 带上传进度的 POST 请求（支持 AbortSignal 取消） */
  upload<T>(
    endpoint: string,
    formData: FormData,
    onProgress?: (percent: number) => void,
    signal?: AbortSignal,
  ): Promise<T>;
  /** SSE 流式 POST 请求（逐块读取，支持取消） */
  streamPost(
    endpoint: string,
    body: unknown,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
    options?: Pick<RequestOptions, "headers" | "auth">,
  ): Promise<void>;
}

/** SSE 流式回调接口 */
export interface StreamCallbacks {
  /** 收到 sources 事件（引用来源） */
  onSources?: (sources: unknown[]) => void;
  /** 收到 chunk 事件（文本增量） */
  onChunk?: (text: string) => void;
  /** 收到 done 事件（流结束，携带完整回答） */
  onDone?: (data: {
    content: string;
    model?: string;
    metrics?: unknown;
    degraded?: boolean;
    /** 对话ID（文档对话后端在 done 事件中返回，用于刷新侧边栏对话列表） */
    conversation_id?: number;
  }) => void;
  /** 收到 error 事件 */
  onError?: (message: string) => void;
}

/** API 客户端实例 */
export const apiClient: ApiClient = {
  /**
   * 发送 HTTP 请求
   *
   * @param endpoint - API 路径（不含 baseUrl，如 '/auth/login'）
   * @param options - 请求配置
   * @returns 解析后的响应数据
   * @throws HttpClientError 当请求失败时抛出
   */
  async request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
    const generation = getAccountGeneration();
    const url = `${getAccountServer()}${endpoint}`;
    const autoRefresh = options.autoRefresh !== false;

    const config: RequestInit = {
      ...options,
      headers: buildHeaders(options),
    };

    let response: Response;
    try {
      response = await accountFetch(url, config);

      // 401 时尝试刷新 Token 并重试
      if (response.status === 401 && autoRefresh && options.auth !== false) {
        const newToken = await refreshAccessToken();
        if (newToken) {
          // 用新 Token 重试原请求
          config.headers = buildHeaders(options);
          response = await accountFetch(url, config);
        }
      }
    } catch (err) {
      // 网络错误（无法连接服务器）→ 转换为友好中文提示
      throw toFriendlyNetworkError(err);
    }

    if (!response.ok) {
      throw await parseError(response);
    }

    // 204 No Content
    if (response.status === 204) {
      return undefined as T;
    }

    let data: T;
    try { data = await response.json(); }
    catch (error) {
      if (generation !== getAccountGeneration() || options.signal?.aborted) throw error;
      throw new HttpClientError(response.status, '响应格式无效', `服务器返回 HTTP ${response.status}，但响应不是有效的 JSON。`);
    }
    if (generation !== getAccountGeneration()) throw new DOMException('账号服务器已切换', 'AbortError');
    return data;
  },

  /** GET 请求 */
  get<T>(endpoint: string, options?: RequestOptions): Promise<T> {
    return this.request(endpoint, { ...options, method: "GET" });
  },

  /**
   * GET 请求（返回纯文本）
   *
   * 作用：
   *   与 get<T> 类似，但返回 response.text() 而非 response.json()。
   *   用于后端返回 PlainTextResponse 的接口（如文档内容预览 /documents/{id}/content）。
   *   包含完整的 Token 注入、401 自动刷新、网络错误友好提示逻辑。
   *
   * @param endpoint - API 路径（不含 baseUrl）
   * @param options - 请求配置
   * @returns 响应体纯文本
   * @throws HttpClientError 当请求失败时抛出
   */
  async getText(endpoint: string, options: RequestOptions = {}): Promise<string> {
    const generation = getAccountGeneration();
    const url = `${getAccountServer()}${endpoint}`;
    const autoRefresh = options.autoRefresh !== false;

    const config: RequestInit = {
      ...options,
      headers: buildHeaders(options),
      method: "GET",
    };

    let response: Response;
    try {
      response = await accountFetch(url, config);

      // 401 时尝试刷新 Token 并重试
      if (response.status === 401 && autoRefresh && options.auth !== false) {
        const newToken = await refreshAccessToken();
        if (newToken) {
          config.headers = buildHeaders(options);
          response = await accountFetch(url, config);
        }
      }
    } catch (err) {
      throw toFriendlyNetworkError(err);
    }

    if (!response.ok) {
      throw await parseError(response);
    }

    const data = await response.text();
    if (generation !== getAccountGeneration()) throw new DOMException('账号服务器已切换', 'AbortError');
    return data;
  },

  /**
   * GET 请求（返回 Blob）
   *
   * 作用：
   *   用于下载二进制内容（如 PDF 文件流），返回 Blob 供前端创建 Object URL。
   *   包含完整的 Token 注入、401 自动刷新、网络错误友好提示逻辑。
   *
   * @param endpoint - API 路径（不含 baseUrl）
   * @param options - 请求配置
   * @returns 响应体 Blob
   * @throws HttpClientError 当请求失败时抛出
   */
  async getBlob(endpoint: string, options: RequestOptions = {}): Promise<Blob> {
    const generation = getAccountGeneration();
    const url = `${getAccountServer()}${endpoint}`;
    const autoRefresh = options.autoRefresh !== false;

    const config: RequestInit = {
      ...options,
      headers: buildHeaders(options),
      method: "GET",
    };

    let response: Response;
    try {
      response = await accountFetch(url, config);

      if (response.status === 401 && autoRefresh && options.auth !== false) {
        const newToken = await refreshAccessToken();
        if (newToken) {
          config.headers = buildHeaders(options);
          response = await accountFetch(url, config);
        }
      }
    } catch (err) {
      throw toFriendlyNetworkError(err);
    }

    if (!response.ok) {
      throw await parseError(response);
    }

    const data = await response.blob();
    if (generation !== getAccountGeneration()) throw new DOMException('账号服务器已切换', 'AbortError');
    return data;
  },

  /** POST 请求 */
  post<T>(
    endpoint: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<T> {
    const isFormData = body instanceof FormData;
    return this.request(endpoint, {
      ...options,
      method: "POST",
      body: isFormData ? body : JSON.stringify(body),
    });
  },

  /** PATCH 请求 */
  patch<T>(
    endpoint: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<T> {
    return this.request(endpoint, {
      ...options,
      method: "PATCH",
      body: JSON.stringify(body),
    });
  },

  /** DELETE 请求 */
  delete<T>(endpoint: string, options?: RequestOptions): Promise<T> {
    return this.request(endpoint, { ...options, method: "DELETE" });
  },

  /**
   * 带上传进度的 POST 请求（支持 AbortSignal 取消）
   *
   * 作用：
   *   fetch API 不支持上传进度，使用 XMLHttpRequest 实现。
   *   用于文件上传场景。支持通过 AbortSignal 取消上传。
   *
   * @param endpoint - API 路径
   * @param formData - FormData 对象
   * @param onProgress - 进度回调
   * @param signal - AbortSignal，用于取消上传
   * @returns 解析后的响应数据
   * @throws {DOMException} 当通过 signal 取消时抛出 AbortError
   */
  upload<T>(
    endpoint: string,
    formData: FormData,
    onProgress?: (percent: number) => void,
    signal?: AbortSignal,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const url = `${getAccountServer()}${endpoint}`;

      // [Bug-2 修复] xhr.open() 必须在 setRequestHeader 之前调用
      xhr.open("POST", url);

      // 注入 Token（open 之后才能设置 header）
      const tokens = getStoredTokens();
      if (tokens?.access_token) {
        xhr.setRequestHeader("Authorization", `Bearer ${tokens.access_token}`);
      }

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) {
          const percent = Math.round((e.loaded / e.total) * 100);
          onProgress(percent);
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText) as T);
          } catch {
            resolve(undefined as T);
          }
        } else {
          let detail: ApiError["detail"] = xhr.statusText;
          try {
            const body: ApiError = JSON.parse(xhr.responseText);
            detail = body.detail;
          } catch {
            // 非 JSON 响应
          }
          reject(new HttpClientError(xhr.status, detail));
        }
      };

      xhr.onerror = () => {
        reject(new HttpClientError(
          0,
          getNetworkErrorMessage(),
          getNetworkErrorMessage(),
        ));
      };

      // 处理取消信号
      if (signal) {
        // 如果已经取消，直接 reject
        if (signal.aborted) {
          xhr.abort();
          reject(new DOMException("上传已取消", "AbortError"));
          return;
        }

        // 监听取消事件
        signal.addEventListener("abort", () => {
          xhr.abort();
          reject(new DOMException("上传已取消", "AbortError"));
        });
      }

      const serverSignal = getAccountSignal();
      const serverAbort = () => { xhr.abort(); reject(new DOMException("账号服务器已切换", "AbortError")); };
      serverSignal.addEventListener("abort", serverAbort, { once: true });
      xhr.onloadend = () => serverSignal.removeEventListener("abort", serverAbort);
      xhr.send(formData);
    });
  },

  /**
   * SSE 流式 POST 请求
   *
   * 作用：
   *   发送 POST 请求并以流式方式读取响应（Server-Sent Events）。
   *   后端返回 text/event-stream 格式，每行 `data: {json}\n\n`。
   *   逐块解析并触发对应回调，实现打字机效果。
   *
   * 使用场景：
   *   聊天问答流式输出（POST /chat/ask/stream）
   *
   * 实现方式：
   *   1. fetch POST 获取 ReadableStream
   *   2. 用 TextDecoder 逐块解码
   *   3. 按 `\n\n` 分割 SSE 事件，解析 `data: ` 前缀的 JSON
   *   4. 根据 type 字段触发对应回调
   *   5. 支持 AbortSignal 取消
   *
   * @param endpoint - API 路径
   * @param body - 请求体（会 JSON.stringify）
   * @param callbacks - SSE 事件回调
   * @param signal - AbortSignal，用于取消流式请求
   * @throws HttpClientError 当请求失败（非 2xx）时抛出
   * @throws DOMException 当通过 signal 取消时抛出 AbortError
   */
  async streamPost(
    endpoint: string,
    body: unknown,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
    options?: Pick<RequestOptions, "headers" | "auth">,
  ): Promise<void> {
    const url = `${getAccountServer()}${endpoint}`;
    const headers = buildHeaders({
      method: "POST",
      body: JSON.stringify(body),
      headers: options?.headers,
      auth: options?.auth,
    });

    let response: Response;
    try {
      response = await accountFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      // 网络错误（无法连接服务器）→ 转换为友好中文提示
      // 注意：AbortError 不在此处理（用户主动取消）
      if (err instanceof DOMException && err.name === "AbortError") {
        throw err;
      }
      throw toFriendlyNetworkError(err);
    }

    // 非 2xx 响应：解析错误并抛出
    if (!response.ok) {
      throw await parseError(response);
    }

    // 无响应体或不支持流式：直接返回
    if (!response.body) {
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    // 缓冲区：累积未解析完的数据，按 `\n\n` 分割 SSE 事件
    let buffer = "";

    /**
     * 解析并分发单个 SSE 事件
     *
     * 作用：
     *   提取 `data:` 行后的 JSON，按 type 字段触发对应回调。
     *   提取为独立函数，使 while 循环内和流结束后的残留处理共用同一逻辑。
     */
    const processEvent = (event: string): void => {
      const line = event.trim();
      if (!line || !line.startsWith("data:")) return;

      // 提取 data: 后的 JSON 内容
      const jsonStr = line.slice(5).trim();
      if (!jsonStr) return;

      try {
        const data = JSON.parse(jsonStr);
        // 根据 type 字段触发对应回调
        switch (data.type) {
          case "sources":
            callbacks.onSources?.(data.content || []);
            break;
          case "chunk":
            callbacks.onChunk?.(data.content || "");
            break;
          case "done":
            callbacks.onDone?.({
              content: data.content || "",
              model: data.model,
              metrics: data.metrics,
              degraded: data.degraded,
              conversation_id: data.conversation_id,
            });
            break;
          case "error":
            callbacks.onError?.(data.content || "未知错误");
            break;
        }
      } catch {
        // JSON 解析失败：跳过该事件（不影响后续处理）
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // 解码当前块并追加到缓冲区
        buffer += decoder.decode(value, { stream: true });

        // 按 `\n\n` 分割 SSE 事件（事件间以空行分隔）
        const events = buffer.split("\n\n");
        // 最后一段可能不完整，保留在缓冲区
        buffer = events.pop() || "";

        // 处理每个完整事件
        for (const event of events) {
          processEvent(event);
        }
      }

      // 修复：流结束后处理 buffer 中残留的最后一个 SSE 事件
      //
      // 问题根因：
      //   当 done 事件是最后一个 SSE 事件时，如果 `\n\n` 分隔符和事件数据
      //   跨在不同的 reader.read() 中（网络分块），或流在事件发送后立即关闭，
      //   done 事件可能残留在 buffer 中不被 split("\n\n") 处理，
      //   导致 onDone 回调不触发 → loadConversations() 不被调用 → 侧边栏不刷新。
      //
      // 修复方式：
      //   流结束时刷新 decoder（获取未完成的 UTF-8 尾字符），
      //   并强制处理 buffer 中残留的事件数据。
      if (buffer.trim()) {
        const tail = decoder.decode();
        if (tail) {
          buffer += tail;
        }
        // 残留数据可能包含一个或多个以 \n\n 分隔的事件，也可能是不完整的单事件
        const tailEvents = buffer.split("\n\n");
        for (const event of tailEvents) {
          processEvent(event);
        }
      }
    } finally {
      // 确保释放 reader
      reader.releaseLock();
    }
  },
};
