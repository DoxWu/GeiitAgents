/**
 * 批量移动文档到分支 / 批量切换文档库弹窗组件
 *
 * 作用：
 *   提供分支选择列表，将选中的多个文档移动到目标分支。
 *   支持移动到已有分支或移出分支（归入未分类）。
 *   支持批量在公共文档库与个人文档库之间迁移（修复问题3b）。
 *
 * 使用方式：
 *   <BatchMoveModal open={open} onClose={() => setOpen(false)} />
 */

import { useState, useEffect } from "react";
import { Building2, Folder as FolderIcon, FileText, Globe, Lock } from "lucide-react";
import { Modal, Button } from "@/components/common";
import { useDocumentStore } from "@/store/documentStore";
import { useAuthStore } from "@/store/authStore";
import { useToastStore } from "@/store/toastStore";
import { cn } from "@/lib/utils";
import type { DocumentVisibility } from "@/types/document";
import { useOrganizationOptions } from "@/hooks/useOrganizationOptions";

/** 文档库选择选项（修复问题3b） */
type LibraryOption = "keep" | DocumentVisibility;

/** BatchMoveModal 组件属性 */
interface BatchMoveModalProps {
  /** 是否打开 */
  open: boolean;
  /** 关闭回调 */
  onClose: () => void;
}

/** BatchMoveModal 组件 */
export function BatchMoveModal({ open, onClose }: BatchMoveModalProps) {
  const { folders, selectedDocIds, batchMove } = useDocumentStore();
  const { user } = useAuthStore();
  const toast = useToastStore();
  const organizations = useOrganizationOptions();
  /** 选中的目标分支ID（null = 未分类） */
  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null);
  /** 选中的目标文档库（修复问题3b，默认保持不变） */
  const [selectedLibrary, setSelectedLibrary] =
    useState<LibraryOption>("keep");
  const [selectedOrganizationId, setSelectedOrganizationId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  /** 当前用户是否为超级管理员（仅管理员可将文档移入公共库） */
  const isSuperuser = !!user?.is_superuser;

  // 弹窗打开时，默认选中"未分类"和"保持文档库不变"
  useEffect(() => {
    if (open) {
      setSelectedFolderId(null);
      setSelectedLibrary("keep");
      setSelectedOrganizationId(null);
    }
  }, [open]);

  /** 提交批量移动 */
  async function handleSubmit() {
    setLoading(true);
    try {
      // 修复问题3b：根据用户选择决定是否传递 folderId / visibility
      // - folderId 始终传递（null = 移出分支），保持原批量操作语义
      // - visibility 仅在用户选择具体库时传递，"keep" 则不传（保持各文档原库不变）
      const visibilityArg =
        selectedLibrary === "keep" ? undefined : selectedLibrary;

      if (selectedLibrary === "organization" && selectedOrganizationId === null) {
        toast.error("请选择组织", "组织共享需要选择一个已加入的组织。");
        return;
      }

      const result = await batchMove(selectedFolderId, visibilityArg,
        selectedLibrary === "organization" ? selectedOrganizationId ?? undefined : undefined);
      if (result.failed.length > 0) {
        toast.warning(
          `操作完成：成功 ${result.success_count} 个，失败 ${result.failed.length} 个`,
        );
      } else {
        // 构建友好提示
        const parts: string[] = [];
        parts.push(
          `已${selectedFolderId === null ? "移出分支" : "移动到目标分支"} ${result.success_count} 个文档`,
        );
        if (selectedLibrary !== "keep") {
          parts.push(
            selectedLibrary === "public" ? "并迁移到公共文档库"
              : selectedLibrary === "organization" ? `并迁移到${organizations.find(item => item.id === selectedOrganizationId)?.name || "组织"}共享库`
                : "并迁移到个人文档库",
          );
        }
        toast.success(parts.join(" · "));
      }
      onClose();
    } catch (err) {
      toast.apiError("批量操作失败", err);
    } finally {
      setLoading(false);
    }
  }

  /** 关闭时重置状态 */
  function handleClose() {
    setSelectedFolderId(null);
    setSelectedLibrary("keep");
    setSelectedOrganizationId(null);
    onClose();
  }

  const selectedCount = selectedDocIds.size;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={`批量操作 ${selectedCount} 个文档`}
      footer={
        <>
          <Button variant="ghost" onClick={handleClose}>
            取消
          </Button>
          <Button onClick={handleSubmit} loading={loading}>
            确认
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* ===== 文档库切换区（修复问题3b） ===== */}
        <div className="space-y-1">
          <p className="mb-2 text-xs font-medium text-ink-secondary">
            文档库
          </p>
          <p className="mb-2 text-xs text-ink-tertiary">
            选择目标文档库，可批量将选中的文档迁移到公共库或个人库。
            选择"保持不变"则不修改各文档的文档库归属。
            {!isSuperuser && " （仅管理员可将文档移入公共库）"}
          </p>

          {/* 保持不变选项 */}
          <button
            type="button"
            onClick={() => setSelectedLibrary("keep")}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
              selectedLibrary === "keep"
                ? "bg-brand-light text-brand"
                : "text-ink-secondary hover:bg-muted hover:text-ink",
            )}
          >
            <FileText className="h-4 w-4" />
            <span>保持各文档原库不变</span>
          </button>

          {/* 个人文档库选项 */}
          <button
            type="button"
            onClick={() => setSelectedLibrary("private")}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
              selectedLibrary === "private"
                ? "bg-brand-light text-brand"
                : "text-ink-secondary hover:bg-muted hover:text-ink",
            )}
          >
            <Lock className="h-4 w-4" />
            <span>迁移到个人文档库</span>
          </button>

          {/* 公共文档库选项 */}
          <button
            type="button"
            onClick={() => setSelectedLibrary("public")}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
              selectedLibrary === "public"
                ? "bg-brand-light text-brand"
                : "text-ink-secondary hover:bg-muted hover:text-ink",
              !isSuperuser && "opacity-60",
            )}
          >
            <Globe className="h-4 w-4" />
            <span>迁移到公共文档库</span>
            {!isSuperuser && (
              <span className="ml-auto text-xs text-ink-tertiary">需管理员</span>
            )}
          </button>
          {organizations.length > 0 && <>
            <button type="button" onClick={() => setSelectedLibrary("organization")} className={cn(
              "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
              selectedLibrary === "organization" ? "bg-brand-light text-brand" : "text-ink-secondary hover:bg-muted hover:text-ink",
            )}><Building2 className="h-4 w-4" /><span>迁移到组织共享库</span></button>
            {selectedLibrary === "organization" && <label className="work-label px-3">目标组织<select aria-label="批量移动目标组织" className="work-input" value={selectedOrganizationId ?? ""} onChange={event => setSelectedOrganizationId(event.target.value ? Number(event.target.value) : null)}><option value="">选择组织</option>{organizations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
          </>}
        </div>

        {/* 分隔线 */}
        <div className="h-px bg-line" />

        {/* ===== 分支选择区 ===== */}
        <div className="space-y-1">
          <p className="mb-2 text-xs font-medium text-ink-secondary">
            所属分支
          </p>
          <p className="mb-3 text-xs text-ink-tertiary">
            选择目标分支，将选中的 {selectedCount} 个文档移动到该分支。选择"未分类"可将文档移出所有分支。
          </p>

          {/* 未分类选项 */}
          <button
            type="button"
            onClick={() => setSelectedFolderId(null)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
              selectedFolderId === null
                ? "bg-brand-light text-brand"
                : "text-ink-secondary hover:bg-muted hover:text-ink",
            )}
          >
            <FileText className="h-4 w-4" />
            <span>未分类</span>
          </button>

          {/* 分支列表 */}
          {folders.length === 0 ? (
            <div className="rounded-md border border-line bg-muted/30 px-3 py-4 text-center text-xs text-ink-tertiary">
              暂无分支，请先在左侧侧边栏创建分支
            </div>
          ) : (
            folders.map((folder) => (
              <button
                key={folder.id}
                type="button"
                onClick={() => setSelectedFolderId(folder.id)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                  selectedFolderId === folder.id
                    ? "bg-brand-light text-brand"
                    : "text-ink-secondary hover:bg-muted hover:text-ink",
                )}
              >
                <FolderIcon className="h-4 w-4" />
                <span className="truncate">{folder.name}</span>
                <span className="ml-auto text-xs text-ink-tertiary">
                  {folder.document_count} 篇
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
}
