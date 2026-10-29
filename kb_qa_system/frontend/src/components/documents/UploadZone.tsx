/**
 * 文件上传区组件
 *
 * 作用：
 *   提供点击上传和拖拽上传两种方式。
 *   支持文件类型校验、大小校验、上传进度显示。
 *   支持上传取消（通过 AbortController 中断上传请求）。
 *
 * 使用方式：
 *   <UploadZone folderId={currentFolderId} />
 */

import { useState, useRef, useCallback } from "react";
import { UploadCloud, File as FileIcon, X, Copy, RefreshCw, Layers } from "lucide-react";
import { Button, Modal } from "@/components/common";
import { useDocumentStore } from "@/store/documentStore";
import { useToastStore } from "@/store/toastStore";
import { SUPPORTED_FILE_TYPES, MAX_FILE_SIZE } from "@/utils/constants";
import { formatFileSize } from "@/utils/format";
import { HttpClientError } from "@/api/client";
import { cn } from "@/lib/utils";
import type { DocumentScope, DocumentVisibility, ConflictResolution } from "@/types/document";

/** 上传中的文件状态 */
interface UploadingFile {
  /** 文件名 */
  name: string;
  /** 文件大小 */
  size: number;
  /** 上传进度（0-100） */
  progress: number;
  /** 上传状态 */
  status: "uploading" | "success" | "error" | "cancelled";
  /** 错误信息 */
  error?: string;
}

/** 文件内容冲突信息（后端返回 FILE_HASH_CONFLICT 时填充） */
interface ConflictInfo {
  /** 触发冲突的文件对象 */
  file: File;
  /** 冲突的现有文档标题 */
  existingTitle: string;
  /** 后端建议的新名称 */
  suggestedName: string;
  /** 冲突的现有文档ID */
  documentId: number;
}

/** UploadZone 组件属性 */
interface UploadZoneProps {
  /** 当前分支ID */
  folderId?: number | null;
  /**
   * 当前文档范围（修复问题3a：上传时根据 scope 派生 visibility）
   * - public：上传到公共文档库（visibility=public，非管理员会被后端降级为 private）
   * - mine / accessible：上传到个人文档库（visibility=private）
   */
  scope?: DocumentScope;
  organizationId?: number;
  /** 是否紧凑模式（在工具栏中使用） */
  compact?: boolean;
}

/** UploadZone 组件 */
export function UploadZone({ folderId, scope, organizationId, compact = false }: UploadZoneProps) {
  const { uploadDocument } = useDocumentStore();
  const toast = useToastStore();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState<UploadingFile[]>([]);
  // 文档重名/重传修复：内容冲突对话框状态
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  const [resolving, setResolving] = useState(false);

  // 存储每个文件上传对应的 AbortController，用于取消上传
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());

  /** 校验文件是否合法
   * @param file - 文件对象
   * @returns 错误信息，合法则返回 null
   */
  function validateFile(file: File): string | null {
    // 获取扩展名（小写）
    const ext = file.name.substring(file.name.lastIndexOf(".")).toLowerCase();
    if (!SUPPORTED_FILE_TYPES.includes(ext)) {
      return `不支持的文件类型: ${ext}`;
    }
    if (file.size > MAX_FILE_SIZE) {
      return `文件过大: ${formatFileSize(file.size)}，最大支持 ${formatFileSize(MAX_FILE_SIZE)}`;
    }
    return null;
  }

  /** 取消指定文件的上传
   * @param fileName - 文件名
   */
  const cancelUpload = useCallback((fileName: string) => {
    const controller = abortControllersRef.current.get(fileName);
    if (controller) {
      controller.abort();
      abortControllersRef.current.delete(fileName);
    }
    // 更新文件状态为已取消
    setUploadingFiles((prev) =>
      prev.map((f) =>
        f.name === fileName && f.status === "uploading"
          ? { ...f, status: "cancelled", error: "已取消" }
          : f,
      ),
    );
  }, []);

  /**
   * 上传单个文件
   *
   * 文档重名/重传修复：
   *   - 首次上传（不传 conflictResolution）：若后端返回 409 FILE_HASH_CONFLICT，
   *     弹出冲突对话框供用户选择处理方式（重命名 / 覆盖 / 保留两者）。
   *   - 冲突解决重传（传 conflictResolution）：携带策略重新上传，不再弹窗。
   *
   * @param file - 要上传的文件
   * @param conflictResolution - 冲突处理策略（仅冲突解决重传时传入）
   */
  const uploadFile = useCallback(
    async (file: File, conflictResolution?: ConflictResolution) => {
      const validationError = validateFile(file);
      if (validationError) {
        toast.error("文件校验失败", validationError);
        return;
      }

      // 创建 AbortController 用于取消上传
      const abortController = new AbortController();
      abortControllersRef.current.set(file.name, abortController);

      // 添加到上传列表
      const fileEntry: UploadingFile = {
        name: file.name,
        size: file.size,
        progress: 0,
        status: "uploading",
      };
      setUploadingFiles((prev) => [...prev, fileEntry]);

      // 修复问题3a：根据当前 scope 派生 visibility，确保拖拽/点击上传能正确归类
      // - scope=public → visibility=public（公共文档库，非管理员会被后端降级为 private）
      // - scope=mine/accessible → visibility=private（个人文档库）
      // 作用：此前未传 visibility，后端默认 private，导致用户在公共库视图下上传的文档
      //       仍归入个人库，列表刷新后看不到，被误判为"统一出现在全部文档"。
      const visibility: DocumentVisibility = organizationId !== undefined
        ? "organization"
        : scope === "public" ? "public" : "private";

      try {
        await uploadDocument(
          {
            file,
            visibility,
            ...(organizationId !== undefined ? { organization_id: organizationId } : {}),
            folder_id: folderId ?? undefined,
            conflict_resolution: conflictResolution,
          },
          (percent) => {
            setUploadingFiles((prev) =>
              prev.map((f) =>
                f.name === file.name ? { ...f, progress: percent } : f,
              ),
            );
          },
          abortController.signal,
        );
        // 上传成功
        setUploadingFiles((prev) =>
          prev.map((f) =>
            f.name === file.name ? { ...f, status: "success", progress: 100 } : f,
          ),
        );
        toast.success("上传成功", file.name);
      } catch (err) {
        // 如果是取消操作，不显示错误 toast（状态已在 cancelUpload 中更新）
        if (err instanceof Error && err.name === "AbortError") {
          return;
        }
        // 文档重名/重传修复：检测文件内容冲突（仅首次上传时弹窗）
        if (
          !conflictResolution &&
          err instanceof HttpClientError &&
          err.status === 409
        ) {
          const errorObj = err.detail as {
            error?: {
              code?: string;
              document_id?: number;
              existing_title?: string;
              suggested_name?: string;
            };
          };
          if (errorObj?.error?.code === "FILE_HASH_CONFLICT") {
            // 弹出冲突对话框，不显示错误 toast
            setConflict({
              file,
              existingTitle: errorObj.error.existing_title || file.name,
              suggestedName: errorObj.error.suggested_name || `${file.name} (1)`,
              documentId: errorObj.error.document_id || 0,
            });
            // 移除上传列表中的该项（本次上传已结束，待用户选择后重新上传）
            setUploadingFiles((prev) => prev.filter((f) => f.name !== file.name));
            return;
          }
        }
        const errorMsg = err instanceof Error ? err.message : "上传失败";
        setUploadingFiles((prev) =>
          prev.map((f) =>
            f.name === file.name ? { ...f, status: "error", error: errorMsg } : f,
          ),
        );
        toast.apiError("上传失败", err);
      } finally {
        // 清理 AbortController 引用
        abortControllersRef.current.delete(file.name);
      }

      // 3秒后移除成功/失败/取消的上传项
      setTimeout(() => {
        setUploadingFiles((prev) =>
          prev.filter((f) => f.name !== file.name),
        );
      }, 3000);
    },
    [folderId, scope, organizationId, uploadDocument, toast],
  );

  /**
   * 解决文件内容冲突
   *
   * 作用：
   *   用户在冲突对话框中选择处理方式后，携带 conflict_resolution 重新上传。
   *   重传期间禁用按钮（resolving 状态），完成后关闭对话框。
   *
   * @param resolution - 用户选择的冲突处理策略
   */
  const resolveConflict = useCallback(
    async (resolution: ConflictResolution) => {
      if (!conflict) return;
      const conflictFile = conflict.file;
      setResolving(true);
      setConflict(null);
      try {
        await uploadFile(conflictFile, resolution);
      } finally {
        setResolving(false);
      }
    },
    [conflict, uploadFile],
  );

  /** 处理文件选择 */
  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    files.forEach((file) => uploadFile(file));
    // 重置 input 以支持重复选择同一文件
    e.target.value = "";
  }

  /** 处理拖拽放置 */
  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    files.forEach((file) => uploadFile(file));
  }

  return (
    <>
      {compact ? (
        // 紧凑模式（工具栏中的上传按钮）
        <>
          <Button
            icon={<UploadCloud className="h-4 w-4" />}
            onClick={() => fileInputRef.current?.click()}
          >
            上传文档
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileSelect}
            accept={SUPPORTED_FILE_TYPES.join(",")}
          />
          {/* 上传进度浮层 */}
          {uploadingFiles.length > 0 && (
            <UploadProgressList
              files={uploadingFiles}
              onCancel={cancelUpload}
            />
          )}
        </>
      ) : (
        // 完整模式（拖拽上传区）
        <div className="space-y-3">
          {/* 拖拽上传区 */}
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed py-8 transition-colors",
              dragOver
                ? "border-brand bg-brand-light"
                : "border-line bg-surface hover:border-brand hover:bg-muted/50",
            )}
          >
            <UploadCloud
              className={cn(
                "h-8 w-8",
                dragOver ? "text-brand" : "text-ink-tertiary",
              )}
            />
            <div className="text-center">
              <p className="text-sm font-medium text-ink">
                点击上传或拖拽文件到此处
              </p>
              <p className="mt-0.5 text-xs text-ink-tertiary">
                支持 {SUPPORTED_FILE_TYPES.join("、")}，单个文件最大{" "}
                {formatFileSize(MAX_FILE_SIZE)}
              </p>
            </div>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileSelect}
            accept={SUPPORTED_FILE_TYPES.join(",")}
          />

          {/* 上传进度列表 */}
          {uploadingFiles.length > 0 && (
            <UploadProgressList
              files={uploadingFiles}
              onCancel={cancelUpload}
            />
          )}
        </div>
      )}

      {/* 文档重名/重传修复：文件内容冲突对话框 */}
      <ConflictDialog
        open={!!conflict}
        conflict={conflict}
        resolving={resolving}
        onResolve={resolveConflict}
        onCancel={() => setConflict(null)}
      />
    </>
  );
}

/**
 * 文件内容冲突对话框
 *
 * 作用：
 *   当上传文件与现有活跃文档内容相同时（FILE_HASH_CONFLICT），
 *   弹出此对话框供用户选择处理方式：
 *   - 自动重命名（rename）：以新名称上传为独立文档
 *   - 覆盖旧文档（overwrite）：软删除冲突文档后上传新文档
 *   - 保留两者（keep_both）：直接上传，两份文档共存
 */
function ConflictDialog({
  open,
  conflict,
  resolving,
  onResolve,
  onCancel,
}: {
  open: boolean;
  conflict: ConflictInfo | null;
  resolving: boolean;
  onResolve: (resolution: ConflictResolution) => void;
  onCancel: () => void;
}) {
  if (!conflict) {
    return <Modal open={open} onClose={onCancel} title="文件内容冲突">{null}</Modal>;
  }

  const options: {
    value: ConflictResolution;
    label: string;
    description: string;
    icon: React.ReactNode;
    danger?: boolean;
  }[] = [
    {
      value: "rename",
      label: "自动重命名",
      description: `以「${conflict.suggestedName}」作为新文档上传，保留原文档`,
      icon: <Copy className="h-4 w-4 text-brand" />,
    },
    {
      value: "overwrite",
      label: "覆盖旧文档",
      description: `软删除「${conflict.existingTitle}」及其检索数据，上传新文档替代`,
      icon: <RefreshCw className="h-4 w-4 text-warning" />,
      danger: true,
    },
    {
      value: "keep_both",
      label: "保留两者",
      description: "直接上传新文档，两份文档共存（内容相同）",
      icon: <Layers className="h-4 w-4 text-ink-secondary" />,
    },
  ];

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="文件内容冲突"
      disableBackdropClose={resolving}
    >
      <div className="space-y-3">
        <p className="text-sm text-ink-secondary">
          上传的文件「{conflict.file.name}」与现有文档「{conflict.existingTitle}」内容相同。请选择处理方式：
        </p>
        <div className="space-y-2">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              disabled={resolving}
              onClick={() => onResolve(option.value)}
              className={cn(
                "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                "border-line bg-surface hover:border-brand hover:bg-muted/50",
                "disabled:cursor-not-allowed disabled:opacity-50",
                option.danger && "hover:border-warning",
              )}
            >
              <span className="mt-0.5 shrink-0">{option.icon}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink">{option.label}</p>
                <p className="mt-0.5 text-xs text-ink-tertiary">
                  {option.description}
                </p>
              </div>
            </button>
          ))}
        </div>
      </div>
      <div className="mt-4 flex justify-end">
        <Button variant="ghost" onClick={onCancel} disabled={resolving}>
          取消上传
        </Button>
      </div>
    </Modal>
  );
}

/** 上传进度列表组件 */
function UploadProgressList({
  files,
  onCancel,
}: {
  files: UploadingFile[];
  onCancel: (fileName: string) => void;
}) {
  return (
    <div className="space-y-2">
      {files.map((file, index) => (
        <div
          key={`${file.name}-${index}`}
          className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2"
        >
          <FileIcon className="h-4 w-4 shrink-0 text-ink-tertiary" />
          <div className="flex-1">
            <div className="flex items-center justify-between">
              <span className="truncate text-xs font-medium text-ink">
                {file.name}
              </span>
              <span className="ml-2 text-xs text-ink-tertiary">
                {file.status === "uploading" && `${file.progress}%`}
                {file.status === "success" && "完成"}
                {file.status === "error" && "失败"}
                {file.status === "cancelled" && "已取消"}
              </span>
            </div>
            {/* 进度条 */}
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full transition-all duration-200",
                  file.status === "error" && "bg-danger",
                  file.status === "success" && "bg-success",
                  file.status === "cancelled" && "bg-ink-tertiary",
                  file.status === "uploading" && "bg-brand",
                )}
                style={{ width: `${file.progress}%` }}
              />
            </div>
          </div>
          {/* 取消按钮：仅上传中显示 */}
          {file.status === "uploading" && (
            <button
              onClick={() => onCancel(file.name)}
              className={cn(
                "flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center",
                "rounded text-ink-tertiary transition-colors",
                "hover:bg-muted hover:text-danger",
                "touch-manipulation",
              )}
              aria-label={`取消上传 ${file.name}`}
              title="取消上传"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
