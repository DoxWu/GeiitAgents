/**
 * client.ts 单元测试
 *
 * 覆盖范围：
 *   - Token 管理：getStoredTokens / storeTokens / updateTokens / clearTokens
 *   - 错误处理：HttpClientError
 *   - HTTP 方法：get / post / delete
 *   - Token 刷新：refreshAccessToken 并发防重
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  HttpClientError,
  getStoredTokens,
  storeTokens,
  updateTokens,
  clearTokens,
  refreshAccessToken,
  apiClient,
} from "@/api/client";
import { TOKEN_STORAGE_KEY } from "@/utils/constants";
import type { TokenResponse } from "@/types/user";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

/** 创建测试用 Token 数据 */
function createMockToken(overrides?: Partial<TokenResponse>): TokenResponse {
  return {
    access_token: "access123",
    refresh_token: "refresh456",
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
    ...overrides,
  };
}

describe("Token 管理", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("getStoredTokens - 无 Token 时返回 null", () => {
    expect(getStoredTokens()).toBeNull();
  });

  it("storeTokens - 存储 Token 后可读取", () => {
    storeTokens(createMockToken());
    const stored = getStoredTokens();
    expect(stored).not.toBeNull();
    expect(stored?.access_token).toBe("access123");
    expect(stored?.refresh_token).toBe("refresh456");
  });

  it("updateTokens - 更新 Token（传入 RefreshTokenResponse）", () => {
    storeTokens(createMockToken());
    updateTokens({
      access_token: "new_access",
      refresh_token: "new_refresh",
      token_type: "bearer",
      expires_in: 7200,
    });
    const stored = getStoredTokens();
    expect(stored?.access_token).toBe("new_access");
    expect(stored?.refresh_token).toBe("new_refresh");
    expect(stored?.expires_in).toBe(7200);
  });

  it("clearTokens - 清除所有 Token", () => {
    storeTokens(createMockToken());
    clearTokens();
    expect(getStoredTokens()).toBeNull();
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });
});

describe("HttpClientError", () => {
  it("携带 status 和 detail", () => {
    const error = new HttpClientError(404, "Not Found");
    expect(error.status).toBe(404);
    expect(error.detail).toBe("Not Found");
    expect(error.message).toContain("404");
    expect(error.name).toBe("HttpClientError");
  });

  it("自定义 message", () => {
    const error = new HttpClientError(500, "Server Error", "自定义错误消息");
    expect(error.message).toBe("自定义错误消息");
  });
});

describe("apiClient.get", () => {
  beforeEach(() => {
    localStorage.clear();
    mockFetch.mockReset();
  });

  it("发送 GET 请求并返回 JSON 数据", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: 1, name: "test" }),
    });

    const result = await apiClient.get<{ id: number; name: string }>("/test");
    expect(result).toEqual({ id: 1, name: "test" });
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain("/test");
    expect(options.method).toBe("GET");
  });

  it("携带 Authorization header（当有 Token 时）", async () => {
    storeTokens(createMockToken({ access_token: "token123" }));

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    });

    await apiClient.get("/protected");
    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers["Authorization"]).toBe("Bearer token123");
  });

  it("HTTP 错误时抛出 HttpClientError", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ detail: "Resource not found" }),
    });

    await expect(apiClient.get("/notfound")).rejects.toThrow(HttpClientError);
  });
});

describe("apiClient.streamPost", () => {
  beforeEach(() => { localStorage.clear(); mockFetch.mockReset(); });

  it("merges request-specific headers into an SSE request", async () => {
    const encoder = new TextEncoder();
    mockFetch.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode('data: {"type":"done","content":"ok"}\n\n')); controller.close(); },
    }), { headers: { "content-type": "text/event-stream" } }));
    await apiClient.streamPost("/private-models/complete/stream", { messages: [] }, {}, undefined, { headers: { "X-Model-Api-Key": "fixture-key" } });
    expect(mockFetch.mock.calls[0][1].headers).toMatchObject({ "X-Model-Api-Key": "fixture-key", "Content-Type": "application/json" });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).not.toHaveProperty("api_key");
  });
});

describe("apiClient.post", () => {
  beforeEach(() => {
    localStorage.clear();
    mockFetch.mockReset();
  });

  it("发送 POST 请求并携带 body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ id: 1 }),
    });

    await apiClient.post("/items", { name: "new item" });
    const [, options] = mockFetch.mock.calls[0];
    expect(options.method).toBe("POST");
    expect(options.body).toBe(JSON.stringify({ name: "new item" }));
    expect(options.headers["Content-Type"]).toBe("application/json");
  });
});

describe("apiClient.delete", () => {
  beforeEach(() => {
    localStorage.clear();
    mockFetch.mockReset();
  });

  it("发送 DELETE 请求", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 204,
      json: async () => null,
    });

    await apiClient.delete("/items/1");
    const [, options] = mockFetch.mock.calls[0];
    expect(options.method).toBe("DELETE");
  });
});

describe("apiClient.patch", () => {
  beforeEach(() => {
    localStorage.clear();
    mockFetch.mockReset();
  });

  it("发送 PATCH 请求并携带 JSON body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: 1, name: "updated" }),
    });

    await apiClient.patch("/items/1", { name: "updated" });
    const [, options] = mockFetch.mock.calls[0];
    expect(options.method).toBe("PATCH");
    expect(options.body).toBe(JSON.stringify({ name: "updated" }));
    expect(options.headers["Content-Type"]).toBe("application/json");
  });
});

describe("apiClient.request - 401 自动刷新重试", () => {
  beforeEach(() => {
    localStorage.clear();
    mockFetch.mockReset();
    storeTokens(
      createMockToken({
        access_token: "old_access",
        refresh_token: "valid_refresh",
      }),
    );
  });

  it("401 后刷新 Token 并重试成功", async () => {
    // 第一次请求 401
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ detail: "Token expired" }),
    });
    // 刷新 Token 请求成功
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new_access",
        refresh_token: "new_refresh",
        token_type: "bearer",
        expires_in: 3600,
      }),
    });
    // 重试请求成功
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: "success" }),
    });

    const result = await apiClient.get("/protected");
    expect(result).toEqual({ data: "success" });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("401 刷新失败时抛出 HttpClientError", async () => {
    // 第一次请求 401
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ detail: "Token expired" }),
    });
    // 刷新 Token 请求失败
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ detail: "Invalid refresh token" }),
    });

    await expect(apiClient.get("/protected")).rejects.toThrow(HttpClientError);
  });

  it("204 No Content 返回 undefined", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 204,
      json: async () => null,
    });

    const result = await apiClient.delete("/items/1");
    expect(result).toBeUndefined();
  });
});

describe("refreshAccessToken 并发防重", () => {
  beforeEach(() => {
    localStorage.clear();
    mockFetch.mockReset();
    storeTokens(createMockToken({
      access_token: "old_access",
      refresh_token: "valid_refresh",
    }));
  });

  it("并发调用只发送一次刷新请求", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new_access",
        refresh_token: "new_refresh",
        token_type: "bearer",
        expires_in: 3600,
      }),
    });

    // 并发调用两次（refreshAccessToken 返回 Promise）
    const promise1 = refreshAccessToken();
    const promise2 = refreshAccessToken();

    const [result1, result2] = await Promise.all([promise1, promise2]);

    // 只调用了一次 fetch
    expect(mockFetch).toHaveBeenCalledOnce();
    // 两个 promise 返回相同结果
    expect(result1).toBe(result2);
  });

  it("无 Token 时返回 null", async () => {
    localStorage.clear();
    const result = await refreshAccessToken();
    expect(result).toBeNull();
  });
});

// ============================================
// apiClient.upload - XHR 上传测试
// ============================================

/**
 * 模拟 XHR 类
 *
 * 使用静态属性 lastInstance 追踪最后创建的实例，
 * 使测试能够获取 apiClient.upload 内部 new XMLHttpRequest() 创建的实例，
 * 从而模拟 onload/onerror/onprogress 等事件。
 */
class MockXMLHttpRequest {
  static lastInstance: MockXMLHttpRequest;

  open = vi.fn();
  setRequestHeader = vi.fn();
  send = vi.fn();
  abort = vi.fn();
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  status = 200;
  responseText = JSON.stringify({ id: 1, name: "uploaded" });
  statusText = "OK";

  constructor() {
    MockXMLHttpRequest.lastInstance = this;
  }
}

describe("apiClient.upload", () => {
  let originalXHR: typeof global.XMLHttpRequest;

  beforeEach(() => {
    localStorage.clear();
    originalXHR = global.XMLHttpRequest;
    MockXMLHttpRequest.lastInstance = undefined as unknown as MockXMLHttpRequest;
    global.XMLHttpRequest = MockXMLHttpRequest as unknown as typeof XMLHttpRequest;
  });

  afterEach(() => {
    global.XMLHttpRequest = originalXHR;
  });

  it("成功上传并返回解析后的 JSON 数据", async () => {
    const formData = new FormData();
    formData.append("file", new File(["content"], "test.pdf"));

    const promise = apiClient.upload<{ id: number; name: string }>(
      "/documents/upload",
      formData,
    );

    // 获取 apiClient.upload 内部创建的 XHR 实例
    const xhr = MockXMLHttpRequest.lastInstance;
    xhr.onload!();

    const result = await promise;
    expect(result).toEqual({ id: 1, name: "uploaded" });
    expect(xhr.open).toHaveBeenCalledWith("POST", expect.stringContaining("/documents/upload"));
    expect(xhr.send).toHaveBeenCalledWith(formData);
  });

  it("携带 Authorization header（当有 Token 时）", async () => {
    storeTokens(createMockToken({ access_token: "token123" }));
    const formData = new FormData();

    const promise = apiClient.upload("/upload", formData);
    const xhr = MockXMLHttpRequest.lastInstance;
    xhr.onload!();
    await promise;

    expect(xhr.setRequestHeader).toHaveBeenCalledWith(
      "Authorization",
      "Bearer token123",
    );
  });

  it("上传进度回调被正确调用", async () => {
    const onProgress = vi.fn();
    const formData = new FormData();

    const promise = apiClient.upload("/upload", formData, onProgress);
    const xhr = MockXMLHttpRequest.lastInstance;
    xhr.onload!();
    await promise;

    // 模拟上传进度事件
    if (xhr.upload.onprogress) {
      xhr.upload.onprogress({ lengthComputable: true, loaded: 50, total: 100 } as ProgressEvent);
    }

    expect(onProgress).toHaveBeenCalledWith(50);
  });

  it("HTTP 错误状态码时抛出 HttpClientError", async () => {
    const formData = new FormData();
    const promise = apiClient.upload("/upload", formData);

    // 修改实例属性以模拟错误响应
    const xhr = MockXMLHttpRequest.lastInstance;
    xhr.status = 500;
    xhr.statusText = "Internal Server Error";
    xhr.responseText = JSON.stringify({ detail: "服务器错误" });

    xhr.onload!();

    await expect(promise).rejects.toMatchObject({ name: "HttpClientError" });
    try {
      await promise;
    } catch (e) {
      expect((e as HttpClientError).status).toBe(500);
    }
  });

  it("网络错误时抛出 HttpClientError", async () => {
    const formData = new FormData();
    const promise = apiClient.upload("/upload", formData);

    const xhr = MockXMLHttpRequest.lastInstance;
    xhr.onerror!();

    await expect(promise).rejects.toMatchObject({ name: "HttpClientError" });
  });

  it("已取消的 AbortSignal 立即拒绝 AbortError", async () => {
    const controller = new AbortController();
    controller.abort();

    const formData = new FormData();
    const promise = apiClient.upload("/upload", formData, undefined, controller.signal);

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(MockXMLHttpRequest.lastInstance.abort).toHaveBeenCalled();
  });

  it("上传过程中通过 signal 取消", async () => {
    const controller = new AbortController();
    const formData = new FormData();

    const promise = apiClient.upload("/upload", formData, undefined, controller.signal);

    // 触发取消
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(MockXMLHttpRequest.lastInstance.abort).toHaveBeenCalled();
  });

  it("响应体非 JSON 时返回 undefined", async () => {
    const formData = new FormData();
    const promise = apiClient.upload("/upload", formData);

    const xhr = MockXMLHttpRequest.lastInstance;
    xhr.responseText = "invalid json";
    xhr.onload!();

    const result = await promise;
    expect(result).toBeUndefined();
  });
});
