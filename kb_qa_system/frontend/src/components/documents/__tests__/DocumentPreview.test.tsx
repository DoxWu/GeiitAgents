/**
 * DocumentPreview 组件集成测试
 *
 * 覆盖范围：
 *   - 未打开时不渲染
 *   - 打开时渲染文档详情面板
 *   - 文件名、状态徽章、基本信息展示
 *   - 处理中状态：显示进度条
 *   - 处理失败状态：显示错误信息 + 重新处理按钮
 *   - 质量评分展示
 *   - 内容预览：文本类文件 fetch 内容、PDF iframe、不支持预览提示
 *   - 关闭预览按钮
 *   - 删除文档操作
 *   - 重新处理操作
 *
 * Mock 策略：mock @/store/documentStore、@/store/toastStore、global fetch
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DocumentResponse } from "@/types/document";

const { mockDocStore } = vi.hoisted(() => ({
  mockDocStore: {
    previewDocument: null as DocumentResponse | null,
    previewOpen: false,
    closePreview: vi.fn(),
    removeDocument: vi.fn(),
    reprocessDocument: vi.fn(),
  },
}));

const { mockToastStore } = vi.hoisted(() => ({
  mockToastStore: {
    success: vi.fn(),
    error: vi.fn(),
    apiError: vi.fn(),
  },
}));

vi.mock("@/store/documentStore", () => ({
  useDocumentStore: () => mockDocStore,
}));

vi.mock("@/store/toastStore", () => ({
  useToastStore: () => mockToastStore,
}));

import { DocumentPreview } from "../DocumentPreview";
import { apiClient } from '@/api/client';

/** 创建测试用文档 */
function createMockDoc(
  overrides: Partial<DocumentResponse> = {},
): DocumentResponse {
  return {
    id: 1,
    title: "测试文档",
    file_name: "test.pdf",
    file_type: ".pdf",
    file_size: 1024,
    status: "completed",
    visibility: "private",
    folder_id: null,
    processing_step: null,
    processing_progress: 100,
    quality_score: 85,
    quality_issues: null,
    chunk_count: 5,
    total_tokens: 1000,
    task_id: null,
    error_message: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("DocumentPreview 组件", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(apiClient, 'getBlob').mockResolvedValue(new Blob(['%PDF-test'], { type: 'application/pdf' }));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview-test');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: vi.fn() });
    mockDocStore.previewDocument = null;
    mockDocStore.previewOpen = false;
    localStorage.setItem(
      "kb_auth_tokens",
      JSON.stringify({ access_token: "fake-token" }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("未打开时不渲染", () => {
    const { container } = render(<DocumentPreview />);
    expect(container.firstChild).toBeNull();
  });

  it("打开时渲染文档详情面板", () => {
    mockDocStore.previewOpen = true;
    mockDocStore.previewDocument = createMockDoc();
    render(<DocumentPreview />);
    expect(screen.getByText("文档详情")).toBeInTheDocument();
    expect(screen.getByText("test.pdf")).toBeInTheDocument();
  });

  it("渲染文件类型信息", () => {
    mockDocStore.previewOpen = true;
    mockDocStore.previewDocument = createMockDoc({ file_type: ".pdf" });
    render(<DocumentPreview />);
    expect(screen.getByText(".PDF")).toBeInTheDocument();
  });

  it("渲染文件大小信息", () => {
    mockDocStore.previewOpen = true;
    mockDocStore.previewDocument = createMockDoc({ file_size: 1048576 });
    render(<DocumentPreview />);
    // formatFileSize(1048576) 返回 "1.0 MB"
    expect(screen.getByText("1.0 MB")).toBeInTheDocument();
  });

  it("渲染状态徽章 - 已完成", () => {
    mockDocStore.previewOpen = true;
    mockDocStore.previewDocument = createMockDoc({ status: "completed" });
    render(<DocumentPreview />);
    expect(screen.getByText("已完成")).toBeInTheDocument();
  });

  it("渲染状态徽章 - 处理中", () => {
    mockDocStore.previewOpen = true;
    mockDocStore.previewDocument = createMockDoc({ status: "processing" });
    render(<DocumentPreview />);
    expect(screen.getByText("处理中")).toBeInTheDocument();
  });

  it("处理中状态显示进度条", () => {
    mockDocStore.previewOpen = true;
    mockDocStore.previewDocument = createMockDoc({
      status: "processing",
      processing_progress: 75,
      processing_step: "解析文档",
    });
    render(<DocumentPreview />);
    expect(screen.getByText("解析文档")).toBeInTheDocument();
    expect(screen.getByText("75%")).toBeInTheDocument();
  });

  it("处理失败状态显示错误信息", () => {
    mockDocStore.previewOpen = true;
    mockDocStore.previewDocument = createMockDoc({
      status: "failed",
      error_message: "文件解析失败",
    });
    render(<DocumentPreview />);
    // "处理失败" 出现两次：状态徽章 + 错误信息标题，使用 getAllByText
    expect(screen.getAllByText("处理失败")).toHaveLength(2);
    expect(screen.getByText("文件解析失败")).toBeInTheDocument();
  });

  it("处理失败状态显示重新处理按钮", () => {
    mockDocStore.previewOpen = true;
    mockDocStore.previewDocument = createMockDoc({
      status: "failed",
      error_message: "文件解析失败",
    });
    render(<DocumentPreview />);
    expect(screen.getByText("重新处理")).toBeInTheDocument();
  });

  it("质量评分展示 - 高分", () => {
    mockDocStore.previewOpen = true;
    mockDocStore.previewDocument = createMockDoc({
      quality_score: 90,
      quality_issues: null,
    });
    render(<DocumentPreview />);
    expect(screen.getByText(/90 \/ 100/)).toBeInTheDocument();
  });

  it("质量评分展示 - 质量问题", () => {
    mockDocStore.previewOpen = true;
    mockDocStore.previewDocument = createMockDoc({
      quality_score: 45,
      quality_issues: ["内容过短", "格式混乱"],
    });
    render(<DocumentPreview />);
    expect(screen.getByText(/45 \/ 100/)).toBeInTheDocument();
    expect(screen.getByText(/内容过短、格式混乱/)).toBeInTheDocument();
  });

  it("无质量评分时不显示质量信息", () => {
    mockDocStore.previewOpen = true;
    mockDocStore.previewDocument = createMockDoc({ quality_score: null });
    render(<DocumentPreview />);
    expect(screen.queryByText("质量评分")).not.toBeInTheDocument();
  });

  it("点击关闭按钮调用 closePreview", async () => {
    const user = userEvent.setup();
    mockDocStore.previewOpen = true;
    mockDocStore.previewDocument = createMockDoc();
    render(<DocumentPreview />);
    await user.click(screen.getByLabelText("关闭预览"));
    expect(mockDocStore.closePreview).toHaveBeenCalledTimes(1);
  });

  it("点击删除按钮 - confirm 确认后调用 removeDocument", async () => {
    const user = userEvent.setup();
    mockDocStore.previewOpen = true;
    mockDocStore.previewDocument = createMockDoc();
    mockDocStore.removeDocument.mockResolvedValueOnce(undefined);
    render(<DocumentPreview />);
    await user.click(screen.getByText("删除文档"));
    await waitFor(() => {
      expect(mockDocStore.removeDocument).toHaveBeenCalledWith(1);
    });
    expect(mockToastStore.success).toHaveBeenCalledWith("文档已删除");
  });

  it("删除失败 - 显示错误 toast", async () => {
    const user = userEvent.setup();
    mockDocStore.previewOpen = true;
    mockDocStore.previewDocument = createMockDoc();
    mockDocStore.removeDocument.mockRejectedValueOnce(new Error("无权限"));
    render(<DocumentPreview />);
    await user.click(screen.getByText("删除文档"));
    await waitFor(() => {
      expect(mockToastStore.apiError).toHaveBeenCalledWith("删除失败", expect.objectContaining({ message: "无权限" }));
    });
  });

  it("点击重新处理按钮 - 调用 reprocessDocument", async () => {
    const user = userEvent.setup();
    mockDocStore.previewOpen = true;
    mockDocStore.previewDocument = createMockDoc({
      status: "failed",
      error_message: "失败",
    });
    mockDocStore.reprocessDocument.mockResolvedValueOnce(undefined);
    render(<DocumentPreview />);
    await user.click(screen.getByText("重新处理"));
    await waitFor(() => {
      expect(mockDocStore.reprocessDocument).toHaveBeenCalledWith(1);
    });
    expect(mockToastStore.success).toHaveBeenCalledWith("已重新提交处理");
  });

  it("重新处理失败 - 显示错误 toast", async () => {
    const user = userEvent.setup();
    mockDocStore.previewOpen = true;
    mockDocStore.previewDocument = createMockDoc({
      status: "failed",
      error_message: "失败",
    });
    mockDocStore.reprocessDocument.mockRejectedValueOnce(new Error("服务不可用"));
    render(<DocumentPreview />);
    await user.click(screen.getByText("重新处理"));
    await waitFor(() => {
      expect(mockToastStore.apiError).toHaveBeenCalledWith("操作失败", expect.objectContaining({ message: "服务不可用" }));
    });
  });

  it("文本类文件预览 - fetch 内容成功", async () => {
    mockDocStore.previewOpen = true;
    mockDocStore.previewDocument = createMockDoc({
      file_type: ".txt",
      file_name: "readme.txt",
      status: "completed",
    });
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => "这是文件内容",
    });
    vi.stubGlobal("fetch", mockFetch);

    render(<DocumentPreview />);
    await waitFor(() => {
      expect(screen.getByText("这是文件内容")).toBeInTheDocument();
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/documents/1/content"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer fake-token",
        }),
      }),
    );
  });

  it("文本类文件预览 - fetch 失败显示错误", async () => {
    mockDocStore.previewOpen = true;
    mockDocStore.previewDocument = createMockDoc({
      file_type: ".txt",
      status: "completed",
    });
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => "Not Found",
    });
    vi.stubGlobal("fetch", mockFetch);

    render(<DocumentPreview />);
    await waitFor(() => {
      expect(screen.getByText("预览内容加载失败")).toBeInTheDocument();
    });
  });

  it("PDF 文件通过鉴权 Blob 加载并在关闭时释放 URL", async () => {
    mockDocStore.previewOpen = true;
    mockDocStore.previewDocument = createMockDoc({
      file_type: ".pdf",
      status: "completed",
    });

    const { container, rerender } = render(<DocumentPreview />);
    await waitFor(() => {
      const iframe = container.querySelector("iframe");
      expect(iframe).not.toBeNull();
      expect(iframe?.getAttribute("src")).toBe('blob:preview-test');
    });
    expect(apiClient.getBlob).toHaveBeenCalledWith('/documents/1/content', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    mockDocStore.previewOpen = false;
    rerender(<DocumentPreview />);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-test');
  });

  it('切换文档后忽略旧 PDF 响应，卸载中止请求并释放当前 URL', async () => {
    let finish!: (value: Blob) => void;
    vi.mocked(apiClient.getBlob).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    mockDocStore.previewOpen = true;
    mockDocStore.previewDocument = createMockDoc();
    const { rerender, unmount } = render(<DocumentPreview />);
    const oldSignal = vi.mocked(apiClient.getBlob).mock.calls[0][1]?.signal;
    mockDocStore.previewDocument = createMockDoc({ id: 2 });
    rerender(<DocumentPreview />);
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
    await act(async () => finish(new Blob(['old PDF'])));
    expect(oldSignal?.aborted).toBe(true);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-test');
  });

  it('PDF 原文件缺失时显示服务端文本回退，不创建 iframe', async () => {
    vi.mocked(apiClient.getBlob).mockResolvedValueOnce({ type: 'text/plain', text: async () => '提取内容回退' } as Blob);
    mockDocStore.previewOpen = true;
    mockDocStore.previewDocument = createMockDoc();
    const { container } = render(<DocumentPreview />);
    expect(await screen.findByText('提取内容回退')).toBeInTheDocument();
    expect(container.querySelector('iframe')).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("不支持预览的文件类型显示提示", () => {
    mockDocStore.previewOpen = true;
    mockDocStore.previewDocument = createMockDoc({
      file_type: ".zip",
      status: "completed",
    });
    render(<DocumentPreview />);
    expect(screen.getByText("该文件类型暂不支持在线预览")).toBeInTheDocument();
    expect(screen.getByText(/(.zip)/)).toBeInTheDocument();
  });

  it("未完成状态不显示内容预览区", () => {
    mockDocStore.previewOpen = true;
    mockDocStore.previewDocument = createMockDoc({
      status: "processing",
    });
    render(<DocumentPreview />);
    expect(screen.queryByText("内容预览")).not.toBeInTheDocument();
  });

  it("渲染分块数量和 Token 数", () => {
    mockDocStore.previewOpen = true;
    mockDocStore.previewDocument = createMockDoc({
      chunk_count: 10,
      total_tokens: 5000,
    });
    render(<DocumentPreview />);
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("5,000")).toBeInTheDocument();
  });

  it("无分块和 Token 时显示占位符", () => {
    mockDocStore.previewOpen = true;
    mockDocStore.previewDocument = createMockDoc({
      chunk_count: 0,
      total_tokens: 0,
    });
    render(<DocumentPreview />);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("title 与 file_name 不同时显示 title", () => {
    mockDocStore.previewOpen = true;
    mockDocStore.previewDocument = createMockDoc({
      title: "自定义标题",
      file_name: "original_name.pdf",
    });
    render(<DocumentPreview />);
    expect(screen.getByText("自定义标题")).toBeInTheDocument();
    expect(screen.getByText("original_name.pdf")).toBeInTheDocument();
  });
});
