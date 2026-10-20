/**
 * chat.ts 单元测试
 *
 * 覆盖范围：
 *   - ask：非流式提问
 *   - askStream：流式提问（SSE 回调传递）
 *   - getConversations：对话列表分页查询
 *   - getConversationDetail：对话详情
 *   - deleteConversation：删除对话
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// 使用 vi.hoisted 确保 mock 对象在 vi.mock 提升时可用
const { mockApiClient } = vi.hoisted(() => ({
  mockApiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    upload: vi.fn(),
    streamPost: vi.fn(),
  },
}));

vi.mock("@/api/client", () => ({
  apiClient: mockApiClient,
}));

import { ask, askStream, regenerateStream, getConversations, getConversationDetail, deleteConversation } from "@/api/chat";
import { setRerankMode } from '@/services/rerankPreference';
import { safeStorage } from '@/utils/safeStorage';
import { USER_STORAGE_KEY } from '@/utils/constants';
import type { AnswerResponse, Conversation, ConversationListResponse } from "@/types/chat";

describe("chat API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  describe("ask", () => {
    it('将显式选择同时用于非流式、流式及重新生成，默认可恢复', async () => {
      safeStorage.setItem(USER_STORAGE_KEY, JSON.stringify({ id: 17 }));
      setRerankMode(17, 'qwen3.7-text-rerank');
      await ask({ question: 'test' });
      expect(mockApiClient.post.mock.calls.at(-1)?.[1]).toMatchObject({ rerank_mode: 'qwen3.7-text-rerank' });
      await askStream({ question: 'test' }, {});
      expect(mockApiClient.streamPost.mock.calls.at(-1)?.[1]).toMatchObject({ rerank_mode: 'qwen3.7-text-rerank' });
      await regenerateStream({ conversation_id: 1 }, {});
      expect(mockApiClient.streamPost.mock.calls.at(-1)?.[1]).toMatchObject({ rerank_mode: 'qwen3.7-text-rerank' });
      setRerankMode(17, 'current');
      await ask({ question: 'test' });
      expect(mockApiClient.post.mock.calls.at(-1)?.[1]).toEqual({ question: 'test' });
    });
    it("调用 POST /chat/ask 并返回回答", async () => {
      const mockResponse: AnswerResponse = {
        answer: "测试回答",
        sources: [],
        conversation_id: 1,
        message_id: 2,
        degraded: false,
      };
      mockApiClient.post.mockResolvedValueOnce(mockResponse);

      const result = await ask({ question: "测试问题" });

      expect(mockApiClient.post).toHaveBeenCalledOnce();
      expect(mockApiClient.post).toHaveBeenCalledWith("/chat/ask", {
        question: "测试问题",
      });
      expect(result).toEqual(mockResponse);
    });

    it("传递 conversation_id 和 idempotency_key", async () => {
      mockApiClient.post.mockResolvedValueOnce({
        answer: "",
        sources: [],
        conversation_id: 1,
        degraded: false,
      });

      await ask({
        question: "测试",
        conversation_id: 42,
        idempotency_key: "key-123",
      });

      expect(mockApiClient.post).toHaveBeenCalledWith("/chat/ask", {
        question: "测试",
        conversation_id: 42,
        idempotency_key: "key-123",
      });
    });
  });

  describe("askStream", () => {
    it("调用 streamPost 并传递回调和 signal", async () => {
      const callbacks = {
        onChunk: vi.fn(),
        onDone: vi.fn(),
      };
      const signal = new AbortController().signal;
      mockApiClient.streamPost.mockResolvedValueOnce(undefined);

      await askStream({ question: "流式测试" }, callbacks, signal);

      expect(mockApiClient.streamPost).toHaveBeenCalledOnce();
      const args = mockApiClient.streamPost.mock.calls[0];
      expect(args[0]).toBe("/chat/ask/stream");
      expect(args[1]).toEqual({ question: "流式测试" });
      expect(args[2]).toBe(callbacks);
      expect(args[3]).toBe(signal);
    });

    it("无 signal 时正常调用", async () => {
      mockApiClient.streamPost.mockResolvedValueOnce(undefined);

      await askStream({ question: "无 signal" }, {});

      expect(mockApiClient.streamPost).toHaveBeenCalledWith(
        "/chat/ask/stream",
        { question: "无 signal" },
        {},
        undefined,
      );
    });
  });

  describe("getConversations", () => {
    it("使用默认分页参数", async () => {
      const mockResponse: ConversationListResponse = {
        items: [],
        total: 0,
        page: 1,
        page_size: 20,
      };
      mockApiClient.get.mockResolvedValueOnce(mockResponse);

      await getConversations();

      const endpoint = mockApiClient.get.mock.calls[0][0];
      expect(endpoint).toContain("page=1");
      expect(endpoint).toContain("page_size=20");
    });

    it("使用自定义分页参数", async () => {
      mockApiClient.get.mockResolvedValueOnce({
        items: [],
        total: 0,
        page: 2,
        page_size: 10,
      });

      await getConversations(2, 10);

      const endpoint = mockApiClient.get.mock.calls[0][0];
      expect(endpoint).toContain("page=2");
      expect(endpoint).toContain("page_size=10");
      expect(endpoint).toMatch(/^\/chat\/conversations\?/);
    });
  });

  describe("getConversationDetail", () => {
    it("调用 GET /chat/conversations/{id}", async () => {
      const mockConversation: Conversation = {
        id: 5,
        title: "测试对话",
        is_active: true,
        created_at: "2026-07-10T00:00:00Z",
        updated_at: "2026-07-10T00:00:00Z",
        messages: [],
      };
      mockApiClient.get.mockResolvedValueOnce(mockConversation);

      const result = await getConversationDetail(5);

      expect(mockApiClient.get).toHaveBeenCalledWith("/chat/conversations/5");
      expect(result).toEqual(mockConversation);
    });
  });

  describe("deleteConversation", () => {
    it("调用 DELETE /chat/conversations/{id}", async () => {
      mockApiClient.delete.mockResolvedValueOnce(undefined);

      await deleteConversation(3);

      expect(mockApiClient.delete).toHaveBeenCalledWith("/chat/conversations/3");
    });
  });
});
