/**
 * URL 导入弹窗组件
 *
 * 作用：
 *   提供通过 URL 导入网页内容的弹窗表单。
 *   用户输入网页 URL，系统下载网页内容并创建文档。
 *   后端内置 SSRF 防护，阻止访问内网地址。
 *
 * 使用方式：
 *   <UrlImportModal open={open} onClose={handleClose} folderId={folderId} />
 */

import { useState } from "react";
import { Modal, Button, Input } from "@/components/common";
import { importFromUrl } from "@/api/document";
import { useToastStore } from "@/store/toastStore";
import type { DocumentVisibility } from "@/types/document";

/** UrlImportModal 组件属性 */
interface UrlImportModalProps {
  /** 是否打开 */
  open: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /** 导入成功后的回调（触发列表刷新） */
  onSuccess?: () => void;
  /** 所属分支ID（可选） */
  folderId?: number | null;
  /** 指定时将网页导入组织共享知识库 */
  organizationId?: number;
}

/** URL 格式校验正则 */
const URL_REGEX = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;

/** UrlImportModal 组件 */
export function UrlImportModal({
  open,
  onClose,
  onSuccess,
  folderId,
  organizationId,
}: UrlImportModalProps) {
  const toast = useToastStore();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [visibility, setVisibility] = useState<DocumentVisibility>("private");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  /** 校验 URL 格式 */
  function validateUrl(value: string): string | null {
    if (!value.trim()) return "URL 不能为空";
    if (!URL_REGEX.test(value.trim())) {
      return "请输入有效的 HTTP/HTTPS URL";
    }
    return null;
  }

  /** 提交导入 */
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedUrl = url.trim();

    const urlError = validateUrl(trimmedUrl);
    if (urlError) {
      setError(urlError);
      return;
    }

    setLoading(true);
    setError("");
    try {
      await importFromUrl({
        url: trimmedUrl,
        title: title.trim() || undefined,
        visibility: organizationId !== undefined ? "organization" : visibility,
        ...(organizationId !== undefined ? { organization_id: organizationId } : {}),
      });
      toast.success("URL 导入成功", "文档正在后台处理中，请稍后查看。");
      // 重置表单
      setUrl("");
      setTitle("");
      setVisibility("private");
      onSuccess?.();
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : "导入失败";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  /** 关闭时重置状态 */
  function handleClose() {
    setUrl("");
    setTitle("");
    setVisibility("private");
    setError("");
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="从 URL 导入文档"
      footer={
        <>
          <Button variant="ghost" onClick={handleClose}>
            取消
          </Button>
          <Button
            form="url-import-form"
            type="submit"
            loading={loading}
          >
            导入
          </Button>
        </>
      }
    >
      <form id="url-import-form" onSubmit={handleSubmit} className="space-y-4">
        {/* URL 输入 */}
        <Input
          label="网页 URL"
          placeholder="https://example.com/article"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            if (error) setError("");
          }}
          error={error}
          autoFocus
        />

        {/* 标题输入（可选） */}
        <Input
          label="文档标题（可选）"
          placeholder="不填则使用网页标题"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />

        {/* 可见性选择 */}
        {organizationId !== undefined ? <p className="text-sm text-ink-secondary">此网页将导入到所选组织的共享知识库。</p> : <div>
          <label className="mb-1.5 block text-sm font-medium text-ink">
            可见性
          </label>
          <div className="flex gap-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="visibility"
                value="private"
                checked={visibility === "private"}
                onChange={() => setVisibility("private")}
                className="text-brand focus:ring-brand"
              />
              <span className="text-sm text-ink-secondary">个人文档库</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="visibility"
                value="public"
                checked={visibility === "public"}
                onChange={() => setVisibility("public")}
                className="text-brand focus:ring-brand"
              />
              <span className="text-sm text-ink-secondary">公共文档库</span>
            </label>
          </div>
        </div>}

        {/* 提示信息 */}
        <p className="text-xs text-ink-tertiary">
          系统将下载网页内容并自动解析。内置 SSRF 防护，请勿尝试访问内网地址。
        </p>

        {/* folderId 隐藏传递（如有） */}
        {folderId && (
          <input type="hidden" name="folder_id" value={folderId} />
        )}
      </form>
    </Modal>
  );
}
