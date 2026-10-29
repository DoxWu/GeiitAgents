/**
 * 管理员注册申请审批页面
 *
 * 作用：
 *   管理员查看注册申请列表，批准或拒绝待审批的申请。
 *   - 状态筛选标签（全部/待审批/已批准/已拒绝）
 *   - 申请列表表格（邮箱、用户名、状态、提交时间、审批时间）
 *   - 批准操作（确认对话框）
 *   - 拒绝操作（弹窗输入拒绝原因，必填）
 *   - 分页控件
 *
 * 使用方式：
 *   通过路由 /admin/applications 访问（受 AdminRoute 保护）。
 */

import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Check,
  X,
  Clock,
  CheckCircle,
  XCircle,
  Mail,
  User as UserIcon,
  ChevronLeft,
  ChevronRight,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/common/Button";
import { useToastStore } from "@/store/toastStore";
import {
  listApplications,
  approveApplication,
  rejectApplication,
} from "@/api/auth";
import type {
  ApplicationListItem,
  ApplicationListResponse,
} from "@/types/user";
import { listOrganizationCatalog, type OrganizationSummary } from "@/api/organizations";

/** 状态筛选选项 */
type StatusFilter = "all" | "pending" | "approved" | "rejected";

/** 每页数量 */
const PAGE_SIZE = 10;

/** 状态标签配置 */
const STATUS_CONFIG: Record<
  string,
  { label: string; icon: typeof Clock; className: string }
> = {
  pending: {
    label: "待审批",
    icon: Clock,
    className: "bg-amber-50 text-amber-700",
  },
  approved: {
    label: "已批准",
    icon: CheckCircle,
    className: "bg-green-50 text-success",
  },
  rejected: {
    label: "已拒绝",
    icon: XCircle,
    className: "bg-red-50 text-danger",
  },
};

/** 筛选标签配置 */
const FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "pending", label: "待审批" },
  { value: "approved", label: "已批准" },
  { value: "rejected", label: "已拒绝" },
];

/** 格式化日期显示 */
function formatDate(isoString: string | null): string {
  if (!isoString) return "—";
  try {
    const date = new Date(isoString);
    return date.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return isoString;
  }
}

/** AdminApplicationsPage 组件 */
export default function AdminApplicationsPage() {
  const navigate = useNavigate();
  const { success, error } = useToastStore();

  // 列表数据
  const [data, setData] = useState<ApplicationListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [page, setPage] = useState(1);

  // 操作状态
  const [approvingId, setApprovingId] = useState<number | null>(null);
  const [rejectingApp, setRejectingApp] = useState<ApplicationListItem | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [organizations, setOrganizations] = useState<OrganizationSummary[]>([]);
  const [organizationChoices, setOrganizationChoices] = useState<Record<number, string>>({});

  useEffect(() => {
    let active = true;
    void listOrganizationCatalog().then(items => { if (active) setOrganizations(items); }).catch(() => { if (active) setOrganizations([]); });
    return () => { active = false; };
  }, []);

  /** 加载申请列表 */
  const loadApplications = useCallback(async () => {
    setLoading(true);
    try {
      const params: { status?: string; page: number; page_size: number } = {
        page,
        page_size: PAGE_SIZE,
      };
      if (statusFilter !== "all") {
        params.status = statusFilter;
      }
      const result = await listApplications(params);
      setData(result);
    } catch (err) {
      error("加载失败", "无法获取申请列表，请稍后重试。");
      console.error("加载申请列表失败:", err);
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter, error]);

  // 初始加载和筛选/页码变化时重新加载
  useEffect(() => {
    loadApplications();
  }, [loadApplications]);

  /** 返回上一页 */
  const handleBack = () => {
    navigate(-1);
  };

  /** 切换筛选状态 */
  const handleFilterChange = (filter: StatusFilter) => {
    setStatusFilter(filter);
    setPage(1); // 重置页码
  };

  /** 批准申请 */
  const handleApprove = async (applicationId: number, currentOrganizationId?: number | null) => {
    setApprovingId(applicationId);
    try {
      const selected = organizationChoices[applicationId] ?? (currentOrganizationId ? String(currentOrganizationId) : "");
      await approveApplication(applicationId, selected ? Number(selected) : null);
      success("批准成功", "密码设置邮件已发送给申请人。");
      // 重新加载列表
      loadApplications();
    } catch (err) {
      error("批准失败", "操作过程中出错，请稍后重试。");
      console.error("批准申请失败:", err);
    } finally {
      setApprovingId(null);
    }
  };

  /** 打开拒绝弹窗 */
  const handleOpenRejectModal = (app: ApplicationListItem) => {
    setRejectingApp(app);
    setRejectReason("");
  };

  /** 关闭拒绝弹窗 */
  const handleCloseRejectModal = () => {
    setRejectingApp(null);
    setRejectReason("");
  };

  /** 确认拒绝申请 */
  const handleConfirmReject = async () => {
    if (!rejectingApp) return;
    if (!rejectReason.trim()) {
      error("拒绝原因必填", "请输入拒绝原因。");
      return;
    }
    setRejecting(true);
    try {
      await rejectApplication(rejectingApp.id, rejectReason.trim());
      success("已拒绝", "拒绝通知邮件已发送给申请人。");
      handleCloseRejectModal();
      loadApplications();
    } catch (err) {
      error("拒绝失败", "操作过程中出错，请稍后重试。");
      console.error("拒绝申请失败:", err);
    } finally {
      setRejecting(false);
    }
  };

  // 计算分页信息
  const total = data?.total ?? 0;
  const pendingCount = data?.pending_count ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const items = data?.items ?? [];

  return (
    <div className="min-h-screen bg-canvas">
      {/* 顶部导航栏 */}
      <header className="sticky top-0 z-10 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-4">
          <button
            onClick={handleBack}
            className="rounded-md p-1.5 text-ink-secondary transition-colors hover:bg-muted hover:text-ink"
            aria-label="返回"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <h1 className="text-lg font-semibold text-ink">注册申请管理</h1>
          {pendingCount > 0 && (
            <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700">
              {pendingCount} 待审批
            </span>
          )}
        </div>
      </header>

      {/* 内容区 */}
      <main className="mx-auto max-w-5xl space-y-4 px-4 py-6">
        {/* 状态筛选标签 */}
        <div className="flex items-center gap-2">
          {FILTER_OPTIONS.map((option) => (
            <button
              key={option.value}
              onClick={() => handleFilterChange(option.value)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                statusFilter === option.value
                  ? "bg-brand text-white"
                  : "bg-surface text-ink-secondary hover:bg-muted"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        {/* 申请列表 */}
        <div className="rounded-lg border border-line bg-surface">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-brand" />
              <span className="ml-2 text-sm text-ink-secondary">加载中...</span>
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-ink-secondary">
              <Mail className="mb-3 h-10 w-10 opacity-30" />
              <p className="text-sm">暂无申请记录</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-ink-secondary">
                    <th className="px-4 py-3 font-medium">申请人</th>
                    <th className="px-4 py-3 font-medium">邮箱</th>
                    <th className="px-4 py-3 font-medium">状态</th>
                    <th className="px-4 py-3 font-medium">提交时间</th>
                    <th className="px-4 py-3 font-medium">审批时间</th>
                    <th className="px-4 py-3 font-medium text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((app) => {
                    const statusCfg = STATUS_CONFIG[app.status] ?? STATUS_CONFIG.pending;
                    const StatusIcon = statusCfg.icon;
                    return (
                      <tr
                        key={app.id}
                        className="border-b border-line last:border-0 hover:bg-muted/50"
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <UserIcon className="h-4 w-4 text-ink-secondary" />
                            <span className="font-medium text-ink">{app.username}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-ink-secondary">{app.email}</td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${statusCfg.className}`}
                          >
                            <StatusIcon className="h-3 w-3" />
                            {statusCfg.label}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-ink-secondary">
                          {formatDate(app.submitted_at)}
                        </td>
                        <td className="px-4 py-3 text-ink-secondary">
                          {formatDate(app.reviewed_at)}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {app.status === "pending" ? (
                            <div className="flex min-w-72 items-center justify-end gap-2">
                              <select aria-label={`${app.username} 的组织`} className="work-input max-w-40 text-xs" value={organizationChoices[app.id] ?? (app.organization_id ? String(app.organization_id) : "")} onChange={event => setOrganizationChoices(current => ({ ...current, [app.id]: event.target.value }))}>
                                <option value="">不加入组织</option>
                                {organizations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                              </select>
                              <button
                                onClick={() => handleApprove(app.id, app.organization_id)}
                                disabled={approvingId === app.id}
                                className="inline-flex items-center gap-1 rounded-md bg-green-50 px-2.5 py-1 text-xs font-medium text-success transition-colors hover:bg-green-100 disabled:opacity-50"
                              >
                                {approvingId === app.id ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Check className="h-3 w-3" />
                                )}
                                批准
                              </button>
                              <button
                                onClick={() => handleOpenRejectModal(app)}
                                className="inline-flex items-center gap-1 rounded-md bg-red-50 px-2.5 py-1 text-xs font-medium text-danger transition-colors hover:bg-red-100"
                              >
                                <X className="h-3 w-3" />
                                拒绝
                              </button>
                            </div>
                          ) : (
                            <span className="text-xs text-ink-secondary">已处理</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* 分页控件 */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between">
            <p className="text-sm text-ink-secondary">
              共 {total} 条记录，第 {page}/{totalPages} 页
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="inline-flex items-center gap-1 rounded-md border border-line px-3 py-1.5 text-sm text-ink-secondary transition-colors hover:bg-muted disabled:opacity-50 disabled:hover:bg-transparent"
              >
                <ChevronLeft className="h-4 w-4" />
                上一页
              </button>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="inline-flex items-center gap-1 rounded-md border border-line px-3 py-1.5 text-sm text-ink-secondary transition-colors hover:bg-muted disabled:opacity-50 disabled:hover:bg-transparent"
              >
                下一页
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </main>

      {/* 拒绝原因弹窗 */}
      {rejectingApp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-md rounded-lg bg-surface p-6 shadow-lg">
            <div className="mb-4 flex items-center gap-2">
              <XCircle className="h-5 w-5 text-danger" />
              <h2 className="text-lg font-semibold text-ink">拒绝申请</h2>
            </div>
            <p className="mb-4 text-sm text-ink-secondary">
              确定拒绝 <strong className="text-ink">{rejectingApp.username}</strong>
              （{rejectingApp.email}）的注册申请吗？请输入拒绝原因（必填，将发送给申请人）：
            </p>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              maxLength={500}
              rows={4}
              placeholder="请输入拒绝原因..."
              className="mb-2 w-full rounded-md border border-line bg-canvas px-3 py-2 text-sm text-ink placeholder:text-ink-secondary focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              autoFocus
            />
            <p className="mb-4 text-right text-xs text-ink-secondary">
              {rejectReason.length}/500
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={handleCloseRejectModal}
                disabled={rejecting}
              >
                取消
              </Button>
              <Button
                variant="danger"
                onClick={handleConfirmReject}
                disabled={rejecting || !rejectReason.trim()}
              >
                {rejecting ? (
                  <>
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    提交中...
                  </>
                ) : (
                  "确认拒绝"
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
