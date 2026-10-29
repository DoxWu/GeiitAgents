/**
 * 用户相关类型定义
 *
 * 作用：
 *   定义用户认证、注册申请等相关的 TypeScript 类型，
 *   与后端 schemas/user.py 中的 Pydantic Schema 对齐。
 *
 * 对齐后端文件：kb_qa_system/backend/app/schemas/user.py
 */

/** 用户信息（对齐后端 UserResponse Schema） */
export interface UserResponse {
  /** 用户ID */
  id: number;
  /** 用户名 */
  username: string;
  /** 邮箱地址 */
  email: string;
  /** 账号是否激活 */
  is_active: boolean;
  /** 是否为超级管理员 */
  is_superuser: boolean;
  /** 用户类型（regular 正式用户 / guest 临时用户） */
  user_type: string;
  /** 创建时间（ISO 8601 字符串） */
  created_at: string;
}

/** 登录请求（对齐后端 UserLogin Schema）
 *  注意：后端使用 username 字段，前端将邮箱作为 username 传入
 */
export interface LoginRequest {
  /** 用户名或邮箱（后端统一用 username 字段接收） */
  username: string;
  /** 密码明文 */
  password: string;
}

/** Token 响应（对齐后端 TokenResponse Schema） */
export interface TokenResponse {
  /** Access Token，用于 API 认证 */
  access_token: string;
  /** Refresh Token，用于刷新 Access Token */
  refresh_token: string;
  /** Token 类型，固定为 "bearer" */
  token_type: string;
  /** Access Token 有效期（秒） */
  expires_in: number;
  /** 当前用户信息 */
  user: UserResponse;
}

/** 刷新 Token 请求（对齐后端 RefreshTokenRequest Schema） */
export interface RefreshTokenRequest {
  refresh_token: string;
}

/** 刷新 Token 响应（对齐后端 RefreshTokenResponse Schema） */
export interface RefreshTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

/** 注册申请请求（需后端新增接口 /auth/register/apply） */
export interface RegisterApplyRequest {
  /** 申请人邮箱 */
  email: string;
  /** 申请用户名 */
  username: string;
  organization_id?: number;
}

/** 注册申请状态 */
export type ApplicationStatus = "pending" | "approved" | "rejected";

/** 注册申请响应 */
export interface RegisterApplyResponse {
  /** 申请ID */
  application_id: number;
  /** 当前申请状态 */
  status: ApplicationStatus;
  /** 提示消息 */
  message: string;
}

/** 申请状态查询响应 */
export interface ApplicationStatusResponse {
  status: ApplicationStatus;
  email: string;
  username: string;
  submitted_at: string;
  reviewed_at: string | null;
  reject_reason: string | null;
}

/** 设置密码请求（需后端新增接口 /auth/set-password） */
export interface SetPasswordRequest {
  /** 邮件链接中的 token */
  token: string;
  /** 新密码 */
  password: string;
}

/** 设置密码响应 */
export interface SetPasswordResponse {
  /** 是否成功 */
  success: boolean;
  /** 提示消息 */
  message: string;
}

/** 申请列表项（管理员查看） */
export interface ApplicationListItem {
  /** 申请 ID */
  id: number;
  /** 申请人邮箱 */
  email: string;
  /** 申请用户名 */
  username: string;
  /** 申请状态 */
  status: ApplicationStatus;
  /** 提交时间（ISO 8601 字符串） */
  submitted_at: string;
  /** 审批时间（ISO 8601 字符串或 null） */
  reviewed_at: string | null;
  /** 审批管理员 ID */
  reviewed_by: number | null;
  organization_id?: number | null;
  /** 拒绝原因 */
  reject_reason: string | null;
}

/** 申请列表响应（管理员查看） */
export interface ApplicationListResponse {
  /** 申请列表 */
  items: ApplicationListItem[];
  /** 申请总数 */
  total: number;
  /** 待审批数量 */
  pending_count: number;
}

/** 批准申请请求 */
export interface ApproveRequest {
  /** 申请 ID */
  application_id: number;
}

/** 拒绝申请请求 */
export interface RejectRequest {
  /** 申请 ID */
  application_id: number;
  /** 拒绝原因（必填） */
  reject_reason: string;
}
