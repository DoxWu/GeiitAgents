/**
 * ChatPage 页面级单元测试
 *
 * 覆盖范围：
 *   - 布局渲染（侧边栏品牌 + 主区域标题）
 *   - mount 时加载对话列表（loadConversations）
 *   - 空状态引导（无消息时显示 EmptyState）
 *   - 加载状态（loadingMessages 时显示 Spinner）
 *   - 消息列表渲染（多条消息全部展示）
 *   - 流式输出临时气泡（streaming 时显示 streamingContent）
 *   - 错误条显示（error 非空时渲染错误文本）
 *   - URL 参数触发对话切换（/chat/:conversationId → selectConversation）
 *
 * Mock 策略：
 *   - useChatStore / useAuthStore / useToastStore 通过 vi.hoisted + vi.mock 替换
 *   - MemoryRouter + Routes 提供 URL 上下文（ChatPage 使用 useParams）
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import ChatPage from "../ChatPage";
import type { ChatMessage } from "@/types/chat";

// ============================================
// Mock 三个 Store（ChatPage + ChatSidebar 依赖的字段并集）
// ============================================

const { mockChatStore } = vi.hoisted(() => ({
  mockChatStore: {
    // 状态字段（ChatPage + ChatSidebar 并集）
    conversations: [] as never[],
    messages: [] as ChatMessage[],
    streaming: false,
    streamingContent: "",
    streamingSources: [] as never[],
    loadingMessages: false,
    loadingConversations: false,
    currentConversationId: null as number | null,
    error: null as string | null,
    // Actions（ChatPage 使用）
    loadConversations: vi.fn(),
    selectConversation: vi.fn(),
    startNewConversation: vi.fn(),
    sendMessage: vi.fn(),
    stopStreaming: vi.fn(),
    // Actions（ChatSidebar 使用）
    removeConversation: vi.fn(),
    clearError: vi.fn(),
  },
}));

const { mockAuthStore } = vi.hoisted(() => ({
  mockAuthStore: {
    user: { username: "testuser", email: "test@test.com" },
    logout: vi.fn(),
  },
}));

const { mockToastStore } = vi.hoisted(() => ({
  mockToastStore: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@/store/chatStore", () => ({
  useChatStore: () => mockChatStore,
}));

vi.mock("@/store/authStore", () => ({
  useAuthStore: () => mockAuthStore,
}));

vi.mock("@/store/toastStore", () => ({
  useToastStore: () => mockToastStore,
}));

// ============================================
// 辅助函数
// ============================================

/** 创建测试用消息 */
function createMessage(overrides?: Partial<ChatMessage>): ChatMessage {
  return {
    id: 1,
    role: "user",
    content: "测试消息",
    created_at: "2026-07-10T10:00:00Z",
    ...overrides,
  };
}

/**
 * 渲染 ChatPage 并注入路由上下文
 *
 * 作用：
 *   ChatPage 使用 useParams 读取 conversationId，需要 Routes/Route 匹配才能获取参数。
 *   同时注册 /chat 和 /chat/:conversationId 两条路由，与 App.tsx 保持一致。
 *
 * 参数：
 *   initialEntry - 初始 URL 路径，默认 "/chat"
 */
function renderChatPage(initialEntry = "/chat") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/chat/:conversationId" element={<ChatPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** 重置 mockChatStore 到默认空状态 */
function resetChatStore() {
  mockChatStore.conversations = [];
  mockChatStore.messages = [];
  mockChatStore.streaming = false;
  mockChatStore.streamingContent = "";
  mockChatStore.streamingSources = [];
  mockChatStore.loadingMessages = false;
  mockChatStore.loadingConversations = false;
  mockChatStore.currentConversationId = null;
  mockChatStore.error = null;
}

// ============================================
// 测试用例
// ============================================

describe("ChatPage 页面", () => {
  beforeEach(() => {
    // 清除所有 mock 调用记录
    vi.clearAllMocks();
    // 重置 store 状态到默认空值
    resetChatStore();
  });

  describe("布局渲染", () => {
    it("渲染侧边栏品牌标识和主区域标题", () => {
      renderChatPage();

      // 侧边栏品牌标识（来自 ChatSidebar）
      expect(screen.getByText("GeiIt企业知识库")).toBeInTheDocument();
      // 主区域标题（currentConversationId 为 null 时显示"新对话"）
      expect(screen.getByRole("heading", { name: "新对话" })).toBeInTheDocument();
    });
  });

  describe("初始化加载", () => {
    it("mount 时调用 loadConversations 加载对话列表", () => {
      renderChatPage();

      expect(mockChatStore.loadConversations).toHaveBeenCalledTimes(1);
    });
  });

  describe("空状态", () => {
    it("无消息且非流式状态时显示开始新对话引导", () => {
      // 默认状态：messages=[]、streaming=false、loadingMessages=false
      renderChatPage();

      expect(screen.getByText("开始新对话")).toBeInTheDocument();
      expect(
        screen.getByText(/在下方输入框中提问，AI 将基于您的知识库回答/),
      ).toBeInTheDocument();
    });
  });

  describe("加载状态", () => {
    it("loadingMessages 为 true 时显示 Spinner 且不显示空状态", () => {
      mockChatStore.loadingMessages = true;
      const { container } = renderChatPage();

      // Spinner 渲染为带 animate-spin 类的 svg
      const spinner = container.querySelector(".animate-spin");
      expect(spinner).toBeInTheDocument();
      // 加载中不应显示空状态引导
      expect(screen.queryByText("开始新对话")).not.toBeInTheDocument();
    });
  });

  describe("消息列表", () => {
    it("渲染所有历史消息", () => {
      mockChatStore.messages = [
        createMessage({ id: 1, role: "user", content: "用户提问内容" }),
        createMessage({ id: 2, role: "assistant", content: "AI回答内容" }),
      ];
      renderChatPage();

      expect(screen.getByText("用户提问内容")).toBeInTheDocument();
      expect(screen.getByText("AI回答内容")).toBeInTheDocument();
    });

    it("有消息时不显示空状态引导", () => {
      mockChatStore.messages = [
        createMessage({ id: 1, role: "user", content: "你好" }),
      ];
      renderChatPage();

      expect(screen.queryByText("开始新对话")).not.toBeInTheDocument();
    });
  });

  describe("流式输出", () => {
    it("streaming 时显示临时 AI 消息气泡（streamingContent）", () => {
      mockChatStore.streaming = true;
      mockChatStore.streamingContent = "AI正在生成回答";
      renderChatPage();

      // 流式临时气泡应显示 streamingContent 文本
      expect(screen.getByText("AI正在生成回答")).toBeInTheDocument();
    });

    it("streaming 时不显示空状态引导", () => {
      mockChatStore.streaming = true;
      mockChatStore.streamingContent = "";
      renderChatPage();

      // 流式输出中不应显示空状态（showEmptyState 排除 streaming）
      expect(screen.queryByText("开始新对话")).not.toBeInTheDocument();
    });
  });

  describe("错误提示", () => {
    it("error 非空时显示错误信息条", () => {
      mockChatStore.error = "网络连接失败，请重试";
      renderChatPage();

      expect(screen.getByText("网络连接失败，请重试")).toBeInTheDocument();
    });

    it("error 为空时不显示错误信息条", () => {
      renderChatPage();

      // 错误条区域不应有 danger 色文本（无错误时不渲染）
      const errorBar = document.querySelector(".bg-red-50");
      expect(errorBar).not.toBeInTheDocument();
    });
  });

  describe("URL 参数处理", () => {
    it("/chat/:conversationId 触发 selectConversation 加载指定对话", () => {
      renderChatPage("/chat/123");

      // URL 参数为 "123"，应调用 selectConversation(123)
      expect(mockChatStore.selectConversation).toHaveBeenCalledWith(123);
    });

    it("/chat（无参数）不触发 selectConversation", () => {
      renderChatPage("/chat");

      // 无 conversationId 参数时不应调用 selectConversation
      expect(mockChatStore.selectConversation).not.toHaveBeenCalled();
    });
  });
});
