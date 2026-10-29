/**
 * 文档项组件
 *
 * 作用：
 *   渲染单个文档信息，包括文件类型图标、文件名、大小、状态、时间。
 *   支持点击预览、删除、重新处理（失败时）操作。
 *
 * 使用方式：
 *   <DocumentItem document={doc} />
 */

import {
  Trash2,
  RefreshCw,
  Eye,
  MoreVertical,
  FolderInput,
  Globe,
  Lock,
  Check,
} from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/common";
import { useDocumentStore } from "@/store/documentStore";
import { useToastStore } from "@/store/toastStore";
import { formatFileSize, formatRelativeTime, getStatusLabel, getProcessingStepLabel } from "@/utils/format";
import { getFileIcon } from "@/utils/fileType";
import { highlightKeyword } from "@/utils/highlight";
import { cn } from "@/lib/utils";
import type { DocumentResponse } from "@/types/document";
import { MoveToFolderModal } from "./MoveToFolderModal";

/** 状态徽章变体映射 */
const STATUS_VARIANT_MAP: Record<
  string,
  "default" | "success" | "warning" | "danger" | "brand"
> = {
  pending: "default",
  processing: "brand",
  completed: "success",
  failed: "danger",
  low_quality: "warning",
};

/** DocumentItem 组件属性 */
interface DocumentItemProps {
  /** 文档数据 */
  document: DocumentResponse;
}

/** DocumentItem 组件 */
export function DocumentItem({ document }: DocumentItemProps) {
  const {
    openPreview,
    removeDocument,
    reprocessDocument,
    searchKeyword,
    selectionMode,
    selectedDocIds,
    toggleSelect,
  } = useDocumentStore();
  const toast = useToastStore();
  const [menuOpen, setMenuOpen] = useState(false);
  const [moveModalOpen, setMoveModalOpen] = useState(false);

  /** 获取文件图标（使用共享 fileType 工具） */
  const IconComp = getFileIcon(document.file_type);

  /** 是否处理中（显示进度条） */
  const isProcessing = document.status === "processing";

  /** 是否处理失败（可重新处理） */
  const isFailed = document.status === "failed";

  /** 是否为公共文档库文档（修复 Issue 8：视觉区分公用/个人文档库） */
  const isPublic = document.visibility === "public";

  /** 当前文档是否被选中 */
  const isSelected = selectedDocIds.has(document.id);

  /** 处理点击事件：多选模式下切换选中，非多选模式下打开预览 */
  function handleClick() {
    if (selectionMode) {
      toggleSelect(document.id);
    } else {
      openPreview(document);
    }
  }

  /** 处理复选框点击（不传播到父元素） */
  function handleCheckboxClick(e: React.MouseEvent) {
    e.stopPropagation();
    toggleSelect(document.id);
  }

  /** 处理删除 */
  async function handleDelete() {
    setMenuOpen(false);
    if (!confirm(`确定删除文档"${document.file_name}"吗？`)) return;
    try {
      await removeDocument(document.id);
      toast.success("文档已删除");
    } catch (err) {
      toast.apiError("删除失败", err);
    }
  }

  /** 处理重新处理 */
  async function handleReprocess() {
    setMenuOpen(false);
    try {
      await reprocessDocument(document.id);
      toast.success("已重新提交处理");
    } catch (err) {
      toast.apiError("操作失败", err);
    }
  }

  /** 处理移动文档（修复 Issue 6：打开移动到分支弹窗） */
  function handleMove() {
    setMenuOpen(false);
    setMoveModalOpen(true);
  }

  return (
    <div
      className={cn(
        "group relative flex items-center gap-3 rounded-lg border bg-surface px-4 py-3",
        "transition-all hover:shadow-sm",
        "cursor-pointer animate-slide-in-right",
        // 修复 Issue 8：公用文档库与个人文档库视觉区分
        isPublic
          ? "border-blue-200 hover:border-blue-400 dark:border-blue-500/40 dark:hover:border-blue-400"
          : "border-line hover:border-brand",
        // 多选选中态：品牌色边框 + 浅色背景
        isSelected && "border-brand bg-brand-light/30 ring-1 ring-brand",
      )}
      onClick={handleClick}
    >
      {/* 多选复选框（多选模式下显示） */}
      {selectionMode && (
        <button
          onClick={handleCheckboxClick}
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 transition-colors",
            isSelected
              ? "border-brand bg-brand text-white"
              : "border-line bg-surface hover:border-brand",
          )}
          aria-label={isSelected ? "取消选中" : "选中文档"}
        >
          {isSelected && <Check className="h-3.5 w-3.5" />}
        </button>
      )}

      {/* 文件类型图标 */}
      <div
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
          isPublic
            ? "bg-blue-50 dark:bg-blue-500/20"
            : "bg-muted",
        )}
      >
        <IconComp
          className={cn(
            "h-5 w-5",
            isPublic
              ? "text-blue-600 dark:text-blue-400"
              : "text-ink-secondary",
          )}
        />
      </div>

      {/* 文档信息 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {/* D2-02 搜索结果高亮：匹配搜索关键词的部分用 <mark> 标记 */}
          <span className="truncate text-sm font-medium text-ink">
            {highlightKeyword(document.file_name, searchKeyword)}
          </span>
          <Badge variant={STATUS_VARIANT_MAP[document.status] || "default"}>
            {getStatusLabel(document.status)}
          </Badge>
          {/* 修复 Issue 8：公用/个人文档库标识 */}
          {isPublic ? (
            <span
              className="inline-flex items-center gap-0.5 rounded-md bg-blue-50 px-1.5 py-0.5 text-xs font-medium text-blue-600 dark:bg-blue-500/20 dark:text-blue-400"
              title="公共文档库"
            >
              <Globe className="h-3 w-3" />
              公共
            </span>
          ) : (
            <span
              className="inline-flex items-center gap-0.5 rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium text-ink-secondary"
              title="个人文档库"
            >
              <Lock className="h-3 w-3" />
              个人
            </span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-ink-tertiary">
          <span>{formatFileSize(document.file_size)}</span>
          <span>·</span>
          <span>{formatRelativeTime(document.updated_at)}</span>
          {document.chunk_count > 0 && (
            <>
              <span>·</span>
              <span>{document.chunk_count} 个分块</span>
            </>
          )}
        </div>

        {/* 处理进度条 */}
        {isProcessing && (
          <div className="mt-2">
            <div className="flex items-center justify-between text-xs text-brand">
              <span>{getProcessingStepLabel(document.processing_step)}</span>
              <span>{document.processing_progress}%</span>
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-brand transition-all duration-300"
                style={{ width: `${document.processing_progress}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* 操作按钮区（多选模式下隐藏） */}
      {!selectionMode && (
        <div className="flex items-center gap-1">
        {/* 预览按钮 */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            openPreview(document);
          }}
          className="rounded p-1.5 text-ink-tertiary opacity-0 transition-opacity hover:bg-muted hover:text-ink group-hover:opacity-100"
          aria-label="预览"
          title="预览"
        >
          <Eye className="h-4 w-4" />
        </button>

        {/* 更多操作菜单 */}
        <div className="relative">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen(!menuOpen);
            }}
            className="rounded p-1.5 text-ink-tertiary opacity-0 transition-opacity hover:bg-muted hover:text-ink group-hover:opacity-100"
            aria-label="更多操作"
          >
            <MoreVertical className="h-4 w-4" />
          </button>

          {menuOpen && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                }}
              />
              <div className="absolute right-0 top-8 z-20 w-32 rounded-md border border-line bg-surface py-1 shadow-lg">
                {/* 修复 Issue 6：移动文档到其他分支 */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleMove();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-ink hover:bg-muted"
                >
                  <FolderInput className="h-3 w-3" />
                  移动到分支
                </button>
                {isFailed && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleReprocess();
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-ink hover:bg-muted"
                  >
                    <RefreshCw className="h-3 w-3" />
                    重新处理
                  </button>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-danger hover:bg-muted"
                >
                  <Trash2 className="h-3 w-3" />
                  删除
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      )}

      {/* 修复 Issue 6：移动文档到其他分支弹窗 + 修复问题3b：切换文档库 */}
      <MoveToFolderModal
        open={moveModalOpen}
        documentId={document.id}
        currentFolderId={document.folder_id}
        currentVisibility={document.visibility}
        currentOrganizationId={document.organization_id}
        onClose={() => setMoveModalOpen(false)}
      />
    </div>
  );
}
