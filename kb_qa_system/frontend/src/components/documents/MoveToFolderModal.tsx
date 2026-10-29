/**
 * 移动文档到其他分支 / 切换文档库弹窗组件
 *
 * 作用：
 *   提供分支选择列表，将指定文档移动到目标分支。
 *   支持移动到已有分支或移出分支（归入未分类）。
 *   支持在公共文档库与个人文档库之间迁移（修复问题3b）。
 *
 * 修复 Issue 6：前端缺少移动文档到其他分支的功能
 * 修复问题3b：添加文档库切换功能，支持在公共库/个人库之间迁移
 *
 * 使用方式：
 *   <MoveToFolderModal
 *     open={open}
 *     documentId={doc.id}
 *     currentFolderId={doc.folder_id}
 *     currentVisibility={doc.visibility}
 *     onClose={() => setOpen(false)}
 *   />
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

/** MoveToFolderModal 组件属性 */
interface MoveToFolderModalProps {
  /** 是否打开 */
  open: boolean;
  /** 文档ID */
  documentId: number;
  /** 当前所属分支ID（用于高亮当前分支） */
  currentFolderId: number | null;
  /** 当前文档库（用于高亮当前库，修复问题3b） */
  currentVisibility: DocumentVisibility;
  currentOrganizationId?: number | null;
  /** 关闭回调 */
  onClose: () => void;
}

/** MoveToFolderModal 组件 */
export function MoveToFolderModal({
  open,
  documentId,
  currentFolderId,
  currentVisibility,
  currentOrganizationId,
  onClose,
}: MoveToFolderModalProps) {
  const { folders, moveDocument } = useDocumentStore();
  const { user } = useAuthStore();
  const toast = useToastStore();
  const organizations = useOrganizationOptions();
  /** 选中的目标分支ID（null = 未分类） */
  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null);
  /** 选中的目标文档库（修复问题3b） */
  const [selectedVisibility, setSelectedVisibility] =
    useState<DocumentVisibility>("private");
  const [selectedOrganizationId, setSelectedOrganizationId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  /** 当前用户是否为超级管理员（仅管理员可将文档移入公共库） */
  const isSuperuser = !!user?.is_superuser;

  // 弹窗打开时，默认选中当前分支和当前文档库
  useEffect(() => {
    if (open) {
      setSelectedFolderId(currentFolderId);
      setSelectedVisibility(currentVisibility);
      setSelectedOrganizationId(currentOrganizationId ?? null);
    }
  }, [open, currentFolderId, currentVisibility, currentOrganizationId]);

  /** 提交移动 */
  async function handleSubmit() {
    // 计算是否有变化：分支或文档库至少一项发生改变
    const folderChanged = selectedFolderId !== currentFolderId;
    const visibilityChanged = selectedVisibility !== currentVisibility
      || selectedVisibility === "organization" && selectedOrganizationId !== (currentOrganizationId ?? null);

    if (selectedVisibility === "organization" && selectedOrganizationId === null) {
      toast.error("请选择组织", "组织共享需要选择一个已加入的组织。");
      return;
    }

    if (!folderChanged && !visibilityChanged) {
      toast.info("文档已在该分支和文档库中");
      onClose();
      return;
    }

    setLoading(true);
    try {
      // 修复问题3b：仅在分支变化时传 folderId（undefined 表示不修改分支）
      // 作用：后端通过是否传递 folder_id 参数区分"移出分支"和"保持原分支"
      const folderIdArg = folderChanged ? selectedFolderId : undefined;
      // 仅在文档库变化时传 visibility（不传则后端保持原库不变）
      const visibilityArg = visibilityChanged ? selectedVisibility : undefined;

      await moveDocument(documentId, folderIdArg, visibilityArg,
        selectedVisibility === "organization" ? selectedOrganizationId ?? undefined : undefined);

      // 构建友好提示
      const parts: string[] = [];
      if (folderChanged) {
        parts.push(selectedFolderId === null ? "移出分支" : "移动到目标分支");
      }
      if (visibilityChanged) {
        parts.push(
          selectedVisibility === "public" ? "迁移到公共文档库"
            : selectedVisibility === "organization" ? `迁移到${organizations.find(item => item.id === selectedOrganizationId)?.name || "组织"}共享库`
              : "迁移到个人文档库",
        );
      }
      toast.success(parts.join(" · "));
      onClose();
    } catch (err) {
      toast.apiError("移动失败", err);
    } finally {
      setLoading(false);
    }
  }

  /** 关闭时重置状态 */
  function handleClose() {
    setSelectedFolderId(null);
    setSelectedVisibility("private");
    setSelectedOrganizationId(null);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="移动文档 / 切换文档库"
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
            选择目标文档库，可将文档在公共库与个人库之间迁移。
            {!isSuperuser && " （仅管理员可将文档移入公共库）"}
          </p>

          {/* 个人文档库选项 */}
          <button
            type="button"
            onClick={() => setSelectedVisibility("private")}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
              selectedVisibility === "private"
                ? "bg-brand-light text-brand"
                : "text-ink-secondary hover:bg-muted hover:text-ink",
            )}
          >
            <Lock className="h-4 w-4" />
            <span>个人文档库</span>
            {currentVisibility === "private" && (
              <span className="ml-auto text-xs text-ink-tertiary">当前</span>
            )}
          </button>

          {/* 公共文档库选项（普通用户也可选，但后端会降级为 private 并通过 toast 反馈） */}
          <button
            type="button"
            onClick={() => setSelectedVisibility("public")}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
              selectedVisibility === "public"
                ? "bg-brand-light text-brand"
                : "text-ink-secondary hover:bg-muted hover:text-ink",
              !isSuperuser && "opacity-60",
            )}
          >
            <Globe className="h-4 w-4" />
            <span>公共文档库</span>
            {!isSuperuser && (
              <span className="ml-auto text-xs text-ink-tertiary">需管理员</span>
            )}
            {currentVisibility === "public" && isSuperuser && (
              <span className="ml-auto text-xs text-ink-tertiary">当前</span>
            )}
          </button>
          {organizations.length > 0 && <>
            <button type="button" onClick={() => setSelectedVisibility("organization")} className={cn(
              "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
              selectedVisibility === "organization" ? "bg-brand-light text-brand" : "text-ink-secondary hover:bg-muted hover:text-ink",
            )}><Building2 className="h-4 w-4" /><span>组织共享库</span></button>
            {selectedVisibility === "organization" && <label className="work-label px-3">组织<select aria-label="目标组织" className="work-input" value={selectedOrganizationId ?? ""} onChange={event => setSelectedOrganizationId(event.target.value ? Number(event.target.value) : null)}><option value="">选择组织</option>{organizations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
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
            选择目标分支，将文档移动到该分支。选择"未分类"可将文档移出所有分支。
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
            {currentFolderId === null && (
              <span className="ml-auto text-xs text-ink-tertiary">当前</span>
            )}
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
                {currentFolderId === folder.id && (
                  <span className="ml-2 text-xs text-brand">当前</span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
}
