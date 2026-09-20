import { apiClient, HttpClientError } from "./client";

export interface MaintenanceStatus {
  enabled: boolean;
  backup_enabled: boolean;
  storage_configured: boolean;
  store_available: boolean;
  restore_target: string | null;
  interval_seconds: number;
  retention_count: number;
  worker_seen_at: string | null;
  worker_available: boolean;
}
export interface Snapshot {
  id: string;
  created_at: string;
  verified: boolean;
  size_bytes: number;
  within_restore_window: boolean;
}
export type JobKind = "backup" | "verify" | "restore";
export interface MaintenanceJob {
  id: string;
  kind: JobKind;
  snapshot_id: string | null;
  actor_id: number;
  state: "queued" | "running" | "succeeded" | "failed" | "interrupted" | "cancelled";
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  result_snapshot_id: string | null;
  error_code: string | null;
}
export interface RestorePlan {
  snapshot_id: string;
  target_name: string;
  target_stamp: string;
  empty: boolean;
  requires_confirmation: boolean;
}
export interface JobInput {
  kind: JobKind;
  request_id: string;
  snapshot_id?: string;
  target_stamp?: string;
  confirmation?: string;
}
const base = "/admin/maintenance";
export const maintenanceApi = {
  status: (signal?: AbortSignal) => apiClient.get<MaintenanceStatus>(`${base}/status`, { signal }),
  snapshots: (signal?: AbortSignal) => apiClient.get<Snapshot[]>(`${base}/snapshots`, { signal }),
  jobs: (signal?: AbortSignal) => apiClient.get<MaintenanceJob[]>(`${base}/jobs`, { signal }),
  plan: (id: string) => apiClient.post<RestorePlan>(`${base}/restore-plan`, { snapshot_id: id }),
  submit: (input: JobInput) => apiClient.post<MaintenanceJob>(`${base}/jobs`, input),
  cancel: (id: string) => apiClient.post<MaintenanceJob>(`${base}/jobs/${id}/cancel`),
};

const messages: Record<string, string> = {
  operations_disabled: "备份管理尚未启用。",
  backup_storage_not_configured: "尚未配置备份存储。",
  backup_disabled: "备份功能已关闭。",
  maintenance_configuration_invalid: "备份服务配置无效，请检查服务端配置。",
  invalid_request: "请求参数无效，请刷新页面后重试。",
  job_not_found: "任务不存在或已不可访问。",
  backup_storage_is_application_database: "备份存储不能指向应用数据库。",
  restore_target_not_configured: "尚未配置恢复目标。",
  restore_target_must_be_separate: "恢复目标必须是单独准备的空数据库。",
  restore_target_not_empty: "恢复目标已有数据，已拒绝覆盖。",
  restore_confirmation_mismatch: "恢复目标确认已失效，请重新检查。",
  restore_target_changed: "恢复目标配置已变更，请重新检查后提交。",
  operation_precondition_failed: "备份或恢复条件不满足，请检查配置及备份有效期。",
  maintenance_unavailable: "备份服务暂不可用，请稍后刷新。",
  idempotency_conflict: "请求内容已变更，请刷新任务列表后重新操作。",
  queue_full: "等待中的任务过多，请稍后再试。",
  job_not_queued: "任务已开始或结束，无法取消，请刷新状态。",
  operation_failed: "执行失败，请检查备份配置、工具版本、权限和存储空间。",
  worker_interrupted: "执行器中断，结果需核查；系统不会自动重复恢复。",
};
export function maintenanceError(error: unknown): string {
  if (typeof error === "string") return messages[error] || "操作未完成，请查看任务状态。";
  if (error instanceof HttpClientError && typeof error.detail === "object" && error.detail && "code" in error.detail) {
    return messages[String(error.detail.code)] || "操作失败，请刷新状态后重试。";
  }
  return "请求未确认成功。请刷新任务列表；重试相同操作会复用请求编号。";
}
