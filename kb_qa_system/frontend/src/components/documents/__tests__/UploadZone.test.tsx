/**
 * UploadZone 组件集成测试
 *
 * 覆盖范围：
 *   - 渲染：拖拽上传区、支持格式提示
 *   - compact 模式：渲染上传按钮
 *   - 文件校验：不支持的类型、文件过大
 *   - 上传成功：调用 uploadDocument + toast
 *   - 上传失败：toast 错误提示
 *
 * Mock 策略：mock @/store/documentStore 和 @/store/toastStore
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { mockDocStore } = vi.hoisted(() => ({
  mockDocStore: {
    uploadDocument: vi.fn(),
  },
}));

const { mockToastStore } = vi.hoisted(() => ({
  mockToastStore: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    apiError: vi.fn(),
  },
}));

vi.mock("@/store/documentStore", () => ({
  useDocumentStore: () => mockDocStore,
}));

vi.mock("@/store/toastStore", () => ({
  useToastStore: () => mockToastStore,
}));

import { UploadZone } from "../UploadZone";

/** 辅助函数：模拟文件选择（通过 fireEvent.change 触发 onChange） */
function uploadFile(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, "files", {
    value: [file],
    writable: false,
    configurable: true,
  });
  fireEvent.change(input);
}

describe("UploadZone 组件", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("完整模式渲染拖拽上传区和格式提示", () => {
    render(<UploadZone />);
    expect(
      screen.getByText("点击上传或拖拽文件到此处"),
    ).toBeInTheDocument();
    expect(screen.getByText(/支持/)).toBeInTheDocument();
  });

  it("compact 模式渲染上传按钮", () => {
    render(<UploadZone compact />);
    expect(screen.getByText("上传文档")).toBeInTheDocument();
  });

  it("不支持的文件类型 - 显示错误 toast", () => {
    render(<UploadZone />);
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;

    const file = new File(["content"], "test.exe", {
      type: "application/octet-stream",
    });
    uploadFile(input, file);

    expect(mockToastStore.error).toHaveBeenCalledWith(
      "文件校验失败",
      expect.stringContaining("不支持的文件类型"),
    );
    expect(mockDocStore.uploadDocument).not.toHaveBeenCalled();
  });

  it("文件过大 - 显示错误 toast", () => {
    render(<UploadZone />);
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;

    // 创建超过 50MB 的文件
    const largeFile = new File(
      [new ArrayBuffer(51 * 1024 * 1024)],
      "large.pdf",
      { type: "application/pdf" },
    );
    uploadFile(input, largeFile);

    expect(mockToastStore.error).toHaveBeenCalledWith(
      "文件校验失败",
      expect.stringContaining("文件过大"),
    );
    expect(mockDocStore.uploadDocument).not.toHaveBeenCalled();
  });

  it("合法文件 - 调用 uploadDocument 并显示成功 toast", async () => {
    mockDocStore.uploadDocument.mockResolvedValueOnce({ id: 1 });
    render(<UploadZone folderId={5} />);
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;

    const file = new File(["content"], "test.pdf", {
      type: "application/pdf",
    });
    uploadFile(input, file);

    // uploadDocument 接收 3 个参数：params（含 visibility）、onProgress、signal
    // 使用 objectContaining 避免冲突未触发时 conflict_resolution=undefined 的比较歧义
    expect(mockDocStore.uploadDocument).toHaveBeenCalledWith(
      expect.objectContaining({ file, folder_id: 5, visibility: "private" }),
      expect.any(Function),
      expect.any(AbortSignal),
    );
    // 等待异步完成
    await waitFor(() => {
      expect(mockToastStore.success).toHaveBeenCalledWith(
        "上传成功",
        "test.pdf",
      );
    });
  });

  it("取消上传 - 点击取消按钮中断上传", async () => {
    // 模拟一个永不 resolve 的 Promise（上传中）
    mockDocStore.uploadDocument.mockReturnValueOnce(new Promise(() => {}));
    render(<UploadZone folderId={5} />);
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;

    const file = new File(["content"], "test.pdf", {
      type: "application/pdf",
    });
    uploadFile(input, file);

    // 等待上传状态出现
    await waitFor(() => {
      expect(screen.getByText("0%")).toBeInTheDocument();
    });

    // 点击取消按钮
    const cancelButton = screen.getByLabelText("取消上传 test.pdf");
    fireEvent.click(cancelButton);

    // 验证状态变为"已取消"
    await waitFor(() => {
      expect(screen.getByText("已取消")).toBeInTheDocument();
    });
  });

  it("上传失败 - 显示错误 toast", async () => {
    mockDocStore.uploadDocument.mockRejectedValueOnce(new Error("网络错误"));
    render(<UploadZone />);
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;

    const file = new File(["content"], "test.txt", { type: "text/plain" });
    uploadFile(input, file);

    await waitFor(() => {
      expect(mockToastStore.apiError).toHaveBeenCalledWith(
        "上传失败",
        expect.objectContaining({ message: "网络错误" }),
      );
    });
  });
});
