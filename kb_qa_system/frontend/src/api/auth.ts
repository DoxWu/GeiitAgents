/**
 * 认证相关 API 接口
 *
 * 作用：
 *   封装登录、注册申请、Token 刷新、登出、密码设置等认证相关接口调用。
 *   所有接口均已对接后端真实路由（注册审批流程已实现）。
 *
 * 对齐后端路由：
 *   - 登录/登出/刷新/用户信息/账号删除/数据导出：kb_qa_system/backend/app/api/routes/auth.py
 *   - 注册申请/审批/密码设置：kb_qa_system/backend/app/api/routes/registration.py
 */

import { apiClient, getStoredTokens } from "./client";
import { API_PATHS } from "@/utils/constants";
import type {
  LoginRequest,
  TokenResponse,
  RefreshTokenResponse,
  UserResponse,
  RegisterApplyRequest,
  RegisterApplyResponse,
  ApplicationStatusResponse,
  SetPasswordRequest,
  SetPasswordResponse,
  ApplicationListResponse,
} from "@/types/user";

/**
 * 用户登录
 *
 * 调用 POST /auth/login，返回 Token 和用户信息。
 * 后端使用 username 字段，前端将邮箱作为 username 传入。
 *
 * @param data - 登录请求（username + password）
 * @returns Token 响应
 */
export async function login(data: LoginRequest, signal?: AbortSignal): Promise<TokenResponse> {
  return apiClient.post<TokenResponse>(API_PATHS.LOGIN, data, { auth: false, autoRefresh: false, ...(signal ? { signal } : {}) });
}

/**
 * 游客临时登录
 *
 * 调用 POST /auth/guest-login，创建临时 guest 用户并返回 Token。
 * guest 用户权限受限：最多 20 次提问、禁止上传文档、仅检索公共库。
 *
 * @returns Token 响应
 */
export async function guestLogin(signal?: AbortSignal): Promise<TokenResponse> {
  return apiClient.post<TokenResponse>(API_PATHS.GUEST_LOGIN, {}, { auth: false, autoRefresh: false, ...(signal ? { signal } : {}) });
}

/**
 * 刷新 Token
 *
 * @param refreshToken - Refresh Token 字符串
 * @returns 新的 Token 响应
 */
export async function refreshToken(
  refreshToken: string,
): Promise<RefreshTokenResponse> {
  return apiClient.post<RefreshTokenResponse>(API_PATHS.REFRESH, {
    refresh_token: refreshToken,
  });
}

/**
 * 登出
 *
 * 调用 POST /auth/logout，将当前 Token 加入黑名单。
 */
export async function logout(): Promise<void> {
  await apiClient.post(API_PATHS.LOGOUT, { refresh_token: getStoredTokens()?.refresh_token }, { autoRefresh: false });
}

/**
 * 获取当前用户信息
 *
 * @returns 当前登录用户信息
 */
export async function getCurrentUser(): Promise<UserResponse> {
  return apiClient.get<UserResponse>(API_PATHS.ME);
}

/**
 * 删除当前用户账号（GDPR/PIPL 合规）
 *
 * 调用 DELETE /auth/account，需密码确认。
 * 删除成功后账号及所有数据将被永久删除，Token 立即失效。
 *
 * @param password - 当前账号密码
 * @param refreshToken - Refresh Token（可选，提供后一并吊销）
 * @returns 删除结果消息
 */
export async function deleteAccount(
  password: string,
  refreshToken?: string,
): Promise<{ message: string }> {
  return apiClient.delete<{ message: string }>(API_PATHS.ACCOUNT_DELETE, {
    body: JSON.stringify({ password, refresh_token: refreshToken }),
  });
}

/**
 * 用户注册（直接注册，非审批流程）
 *
 * 调用 POST /auth/register。
 *
 * @param data - 注册数据（username, email, password）
 * @returns 用户信息
 */
export async function register(data: {
  username: string;
  email: string;
  password: string;
}): Promise<UserResponse> {
  return apiClient.post<UserResponse>(API_PATHS.REGISTER, data);
}

/**
 * 导出当前用户个人数据（GDPR 数据可携权）
 *
 * 调用 GET /auth/export-data，返回用户的所有个人数据（JSON 格式），
 * 包括账号信息、文档列表、对话历史等。
 * 前端将 JSON 数据转换为文件下载。
 *
 * @returns 用户个人数据（JSON 字符串）
 */
export async function exportUserData(): Promise<string> {
  const response = await apiClient.get<unknown>(API_PATHS.EXPORT_DATA);
  return JSON.stringify(response, null, 2);
}

// ============================================
// 注册审批流程接口（后端已实现）
// ============================================

/**
 * 提交注册申请
 *
 * 调用 POST /auth/register/apply，创建 pending 状态的申请记录，
 * 并触发管理员通知邮件。
 *
 * @param data - 注册申请请求（email + username）
 * @returns 申请响应（application_id + status + message）
 */
export async function submitRegisterApply(
  data: RegisterApplyRequest,
): Promise<RegisterApplyResponse> {
  return apiClient.post<RegisterApplyResponse>(API_PATHS.REGISTER_APPLY, data);
}

/**
 * 查询注册申请状态
 *
 * 调用 GET /auth/register/status?email=xxx，按邮箱查询最新申请状态。
 * 响应不含 Token 字段（安全要求）。
 *
 * @param email - 申请人邮箱
 * @returns 申请状态响应
 */
export async function getApplicationStatus(
  email: string,
): Promise<ApplicationStatusResponse> {
  return apiClient.get<ApplicationStatusResponse>(
    `${API_PATHS.REGISTER_STATUS}?email=${encodeURIComponent(email)}`,
  );
}

/**
 * 通过 Token 设置密码
 *
 * 调用 POST /auth/set-password，用邮件链接中的 Token 设置密码并创建账号。
 * Token 一次性使用，24 小时过期。
 *
 * @param data - 设置密码请求（token + password）
 * @returns 设置结果
 */
export async function setPassword(
  data: SetPasswordRequest,
): Promise<SetPasswordResponse> {
  return apiClient.post<SetPasswordResponse>(API_PATHS.SET_PASSWORD, data);
}

/**
 * 管理员查看注册申请列表
 *
 * 调用 GET /auth/register/applications，分页查询申请列表，支持状态筛选。
 * 需要管理员权限。
 *
 * @param params - 查询参数（status, page, page_size）
 * @returns 申请列表响应
 */
export async function listApplications(params?: {
  status?: string;
  page?: number;
  page_size?: number;
}): Promise<ApplicationListResponse> {
  const query = new URLSearchParams();
  if (params?.status) query.set("status", params.status);
  if (params?.page) query.set("page", String(params.page));
  if (params?.page_size) query.set("page_size", String(params.page_size));
  const qs = query.toString();
  return apiClient.get<ApplicationListResponse>(
    `${API_PATHS.REGISTER_APPLICATIONS}${qs ? `?${qs}` : ""}`,
  );
}

/**
 * 管理员批准注册申请
 *
 * 调用 POST /auth/register/approve，批准 pending 状态的申请，
 * 生成密码设置 Token 并发送密码设置邮件给申请人。
 * 需要管理员权限。
 *
 * @param applicationId - 申请 ID
 * @returns 操作结果消息
 */
export async function approveApplication(
  applicationId: number,
): Promise<{ message: string }> {
  return apiClient.post<{ message: string }>(API_PATHS.REGISTER_APPROVE, {
    application_id: applicationId,
  });
}

/**
 * 管理员拒绝注册申请
 *
 * 调用 POST /auth/register/reject，拒绝 pending 状态的申请，
 * 发送拒绝通知邮件（含拒绝原因）给申请人。
 * 需要管理员权限。
 *
 * @param applicationId - 申请 ID
 * @param rejectReason - 拒绝原因（必填，1-500 字符）
 * @returns 操作结果消息
 */
export async function rejectApplication(
  applicationId: number,
  rejectReason: string,
): Promise<{ message: string }> {
  return apiClient.post<{ message: string }>(API_PATHS.REGISTER_REJECT, {
    application_id: applicationId,
    reject_reason: rejectReason,
  });
}
