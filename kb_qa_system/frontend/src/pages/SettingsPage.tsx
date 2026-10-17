/**
 * 设置页面
 *
 * 作用：
 *   展示当前用户账号信息，提供账号管理功能（登出、删除账号）。
 *   删除账号功能满足 GDPR/PIPL 合规要求。
 *
 * 使用方式：
 *   通过路由 /settings 访问（受保护页面）。
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  User as UserIcon,
  Mail,
  Calendar,
  LogOut,
  Trash2,
  Shield,
  MessageSquare,
  FileText,
  Download,
} from "lucide-react";
import { Button } from "@/components/common/Button";
import { useAuthStore } from "@/store/authStore";
import { useToastStore } from "@/store/toastStore";
import { DeleteAccountModal } from "@/components/settings/DeleteAccountModal";
import { exportUserData } from "@/api/auth";

/** 格式化日期显示 */
function formatDate(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return isoString;
  }
}

/** SettingsPage 组件 */
export default function SettingsPage() {
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();
  const { success, error } = useToastStore();
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  /** 返回上一页 */
  const handleBack = () => {
    navigate(-1);
  };

  /** 跳转到文档管理页 */
  const handleGoDocuments = () => {
    navigate("/documents");
  };

  /** 跳转到问答对话页 */
  const handleGoChat = () => {
    navigate("/chat");
  };

  /** 跳转到注册申请管理页（仅管理员） */
  const handleGoAdminApplications = () => {
    navigate("/admin/applications");
  };

  /** 登出 */
  const handleLogout = async () => {
    await logout();
    success("已登出", "您已安全退出登录。");
    navigate("/login", { replace: true });
  };

  /** 打开删除账号弹窗 */
  const handleOpenDeleteModal = () => {
    setDeleteModalOpen(true);
  };

  /** 导出个人数据（GDPR 数据可携权） */
  const handleExportData = async () => {
    setExporting(true);
    try {
      const jsonData = await exportUserData();
      // 创建 Blob 并触发下载
      const blob = new Blob([jsonData], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `geiit-data-export-${user.username}-${new Date().toISOString().split("T")[0]}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      success("数据导出成功", "您的个人数据已下载为 JSON 文件。");
    } catch {
      error("导出失败", "数据导出过程中出错，请稍后重试。");
    } finally {
      setExporting(false);
    }
  };

  // 用户未登录时（理论上 ProtectedRoute 会拦截，此处为防御性检查）
  if (!user) {
    return null;
  }

  return (
    <div className="min-h-screen bg-canvas">
      {/* 顶部导航栏 */}
      <header className="sticky top-0 z-10 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-4">
          <button
            onClick={handleBack}
            className="rounded-md p-1.5 text-ink-secondary transition-colors hover:bg-muted hover:text-ink"
            aria-label="返回"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <h1 className="text-lg font-semibold text-ink">设置</h1>
        </div>
      </header>

      {/* 内容区 */}
      <main className="mx-auto max-w-3xl space-y-6 px-4 py-8">
        {/* 快捷导航 */}
        <section className="rounded-lg border border-line bg-surface p-5">
          <h2 className="mb-4 text-sm font-semibold text-ink">快捷功能</h2>
          <div className="grid grid-cols-2 gap-3">
            <button onClick={() => navigate("/workbench")} className="flex items-center gap-3 rounded-md border border-line p-3 text-left text-sm hover:bg-muted">
              <FileText className="h-4 w-4 text-brand" />办公工作台
            </button>
            <button
              onClick={handleGoDocuments}
              className="flex items-center gap-3 rounded-md border border-line p-3 text-left transition-colors hover:bg-muted"
            >
              <div className="inline-flex h-9 w-9 items-center justify-center rounded bg-brand-light text-brand">
                <FileText className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-medium text-ink">文档管理</p>
                <p className="text-xs text-ink-tertiary">上传和管理文档</p>
              </div>
            </button>
            <button
              onClick={handleGoChat}
              className="flex items-center gap-3 rounded-md border border-line p-3 text-left transition-colors hover:bg-muted"
            >
              <div className="inline-flex h-9 w-9 items-center justify-center rounded bg-brand-light text-brand">
                <MessageSquare className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-medium text-ink">问答对话</p>
                <p className="text-xs text-ink-tertiary">向知识库提问</p>
              </div>
            </button>
            {user.is_superuser && (
              <button
                onClick={handleGoAdminApplications}
                className="flex items-center gap-3 rounded-md border border-line p-3 text-left transition-colors hover:bg-muted"
              >
                <div className="inline-flex h-9 w-9 items-center justify-center rounded bg-brand-light text-brand">
                  <Shield className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-sm font-medium text-ink">注册申请管理</p>
                  <p className="text-xs text-ink-tertiary">审批用户注册申请</p>
                </div>
              </button>
            )}
          </div>
        </section>

        {/* 账号信息 */}
        <section className="rounded-lg border border-line bg-surface p-5">
          <h2 className="mb-4 text-sm font-semibold text-ink">账号信息</h2>
          <div className="space-y-4">
            {/* 用户名 */}
            <div className="flex items-center gap-3">
              <div className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-muted text-ink-secondary">
                <UserIcon className="h-4 w-4" />
              </div>
              <div className="flex-1">
                <p className="text-xs text-ink-tertiary">用户名</p>
                <p className="text-sm font-medium text-ink">{user.username}</p>
              </div>
              {user.is_superuser && (
                <span className="rounded-full bg-brand-light px-2 py-0.5 text-xs font-medium text-brand">
                  管理员
                </span>
              )}
            </div>

            {/* 邮箱 */}
            <div className="flex items-center gap-3">
              <div className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-muted text-ink-secondary">
                <Mail className="h-4 w-4" />
              </div>
              <div className="flex-1">
                <p className="text-xs text-ink-tertiary">邮箱</p>
                <p className="text-sm font-medium text-ink">{user.email}</p>
              </div>
            </div>

            {/* 注册时间 */}
            <div className="flex items-center gap-3">
              <div className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-muted text-ink-secondary">
                <Calendar className="h-4 w-4" />
              </div>
              <div className="flex-1">
                <p className="text-xs text-ink-tertiary">注册时间</p>
                <p className="text-sm font-medium text-ink">
                  {formatDate(user.created_at)}
                </p>
              </div>
            </div>
          </div>
        </section>

        {user.is_superuser && <section className="rounded-lg border border-line bg-surface p-5">
          <h2 className="mb-2 text-sm font-semibold text-ink">系统数据保护</h2>
          <p className="mb-4 text-sm text-ink-secondary">查看备份快照、验证恢复能力并跟踪后台任务。</p>
          <Button variant="secondary" onClick={() => navigate("/admin/backup-recovery")}>备份与恢复</Button>
        </section>}

        {/* 账号操作 */}
        <section className="rounded-lg border border-line bg-surface p-5">
          <h2 className="mb-4 text-sm font-semibold text-ink">账号操作</h2>
          <div className="flex flex-col gap-3">
            <Button
              variant="secondary"
              icon={<LogOut className="h-4 w-4" />}
              onClick={handleLogout}
              fullWidth
            >
              退出登录
            </Button>
          </div>
        </section>

        {/* 数据管理 */}
        <section className="rounded-lg border border-line bg-surface p-5">
          <h2 className="mb-4 text-sm font-semibold text-ink">数据管理</h2>
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <p className="text-sm font-medium text-ink">导出我的数据</p>
              <p className="mt-1 text-xs text-ink-secondary">
                下载您的账号信息、文档列表和对话记录（JSON 格式）。
                满足 GDPR 数据可携权要求。
              </p>
            </div>
            <Button
              variant="secondary"
              icon={<Download className="h-4 w-4" />}
              onClick={handleExportData}
              disabled={exporting}
            >
              {exporting ? "导出中..." : "导出数据"}
            </Button>
          </div>
        </section>

        {/* 危险操作区 */}
        <section className="rounded-lg border border-danger/30 bg-red-50/30 p-5">
          <div className="mb-4 flex items-center gap-2">
            <Shield className="h-4 w-4 text-danger" />
            <h2 className="text-sm font-semibold text-danger">危险操作</h2>
          </div>
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <p className="text-sm font-medium text-ink">删除账号</p>
              <p className="mt-1 text-xs text-ink-secondary">
                删除服务端在线账号及关联记录；服务器文件清理可能异步完成。
                既有备份、已发送邮件和本机数据不会由此删除。
              </p>
            </div>
            <Button
              variant="danger"
              icon={<Trash2 className="h-4 w-4" />}
              onClick={handleOpenDeleteModal}
            >
              删除账号
            </Button>
          </div>
        </section>

        {/* 隐私政策与用户协议链接 */}
        <div className="flex items-center justify-center gap-3 text-center">
          <button
            onClick={() => navigate("/privacy")}
            className="text-xs text-ink-tertiary transition-colors hover:text-brand"
          >
            隐私政策
          </button>
          <span className="text-xs text-ink-tertiary">·</span>
          <button
            onClick={() => navigate("/terms")}
            className="text-xs text-ink-tertiary transition-colors hover:text-brand"
          >
            用户协议
          </button>
        </div>
      </main>

      {/* 删除账号弹窗 */}
      <DeleteAccountModal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        username={user.username}
      />
    </div>
  );
}
