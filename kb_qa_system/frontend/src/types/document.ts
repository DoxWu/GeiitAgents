/**
 * 文档相关类型定义
 *
 * 作用：
 *   定义文档管理、上传、检索等相关的 TypeScript 类型，
 *   与后端 schemas/document.py 中的 Pydantic Schema 对齐。
 *
 * 对齐后端文件：kb_qa_system/backend/app/schemas/document.py
 */

/** 文档处理状态 */
export type DocumentStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "low_quality";

/** 文档可见性 */
export type DocumentVisibility = "private" | "public";

/** 排序字段 */
export type SortField = "created_at" | "updated_at" | "file_name" | "file_type";

/** 排序方向 */
export type SortOrder = "asc" | "desc";

/** 文档信息（对齐后端 DocumentResponse Schema） */
export interface DocumentResponse {
  /** 文档ID */
  id: number;
  /** 文档标题 */
  title: string;
  /** 文件名 */
  file_name: string;
  /** 文件类型（扩展名，如 .pdf） */
  file_type: string;
  /** 文件大小（字节） */
  file_size: number;
  /** 处理状态 */
  status: DocumentStatus;
  /** 可见性：private 个人文档库 / public 公共文档库 */
  visibility: DocumentVisibility;
  /** 所属文档库分支ID（null 表示未分类） */
  folder_id: number | null;
  /** 当前处理步骤描述 */
  processing_step: string | null;
  /** 处理进度（0-100） */
  processing_progress: number;
  /** 质量分（0-100） */
  quality_score: number | null;
  /** 质量问题列表 */
  quality_issues: string[] | null;
  /** 分块数量 */
  chunk_count: number;
  /** 总 Token 数 */
  total_tokens: number;
  /** Celery 任务ID */
  task_id: string | null;
  /** 错误信息（处理失败时） */
  error_message: string | null;
  /** 创建时间（ISO 8601） */
  created_at: string;
  /** 更新时间（ISO 8601） */
  updated_at: string;
}

/** 文档列表响应（对齐后端 DocumentListResponse Schema） */
export interface DocumentListResponse {
  /** 文档列表 */
  items: DocumentResponse[];
  /** 总数 */
  total: number;
  /** 当前页码 */
  page: number;
  /** 每页数量 */
  page_size: number;
}

/** 文档范围筛选（对齐后端 scope 参数） */
export type DocumentScope = "accessible" | "mine" | "public";

/** 文档列表查询参数 */
export interface DocumentQueryParams {
  /** 页码，默认 1 */
  page?: number;
  /** 每页数量，默认 20 */
  page_size?: number;
  /** 按状态筛选 */
  status?: DocumentStatus;
  /** 文件扩展名（例如 .pdf） */
  file_type?: string;
  /** 创建日期起，含当天，按数据库存储日期解释 */
  date_from?: string;
  /** 创建日期止，含当天，按数据库存储日期解释 */
  date_to?: string;
  /** 标题或原始文件名搜索关键词；不搜索正文 */
  search?: string;
  /** 排序字段 */
  sort_by?: SortField;
  /** 排序方向 */
  sort_order?: SortOrder;
  /** 所属文档库分支ID（0 表示未分类/默认分支，≥1 指定分支，不传则不过滤） */
  folder_id?: number;
  /** 文档范围筛选：private 我的文档 / public 公共文档 / all 全部 */
  scope?: DocumentScope;
}

/** 文档上传冲突处理策略（对齐后端 conflict_resolution 参数） */
export type ConflictResolution = "rename" | "overwrite" | "keep_both";

/** 上传文档参数（multipart/form-data） */
export interface UploadDocumentParams {
  /** 文件对象 */
  file: File;
  /** 文档标题（可选，不填用文件名） */
  title?: string;
  /** 文档分类，默认 "other" */
  category?: string;
  /** 可见性，默认 "private" */
  visibility?: DocumentVisibility;
  /** 所属分支ID */
  folder_id?: number;
  /**
   * 冲突处理策略（文档重名/重传修复）
   * - 不传：检测到内容冲突时返回 409，由前端展示选择
   * - rename：自动重命名后作为新文档上传
   * - overwrite：软删除冲突的旧文档后再上传
   * - keep_both：跳过去重，保留两者
   */
  conflict_resolution?: ConflictResolution;
}

/** 任务状态响应（对齐后端 TaskStatusResponse Schema） */
export interface TaskStatusResponse {
  /** 任务ID */
  task_id: string;
  /** 任务状态：PENDING/STARTED/SUCCESS/FAILURE/RETRY */
  status: "PENDING" | "STARTED" | "SUCCESS" | "FAILURE" | "RETRY";
  /** 进度百分比（0-100） */
  progress: number;
  /** 任务结果（成功时） */
  result: unknown;
  /** 错误信息（失败时） */
  error: string | null;
}

/** 文档库分支（需后端新增接口 /documents/folders） */
export interface DocumentFolder {
  /** 分支ID */
  id: number;
  /** 分支名称 */
  name: string;
  /** 该分支下的文档数量 */
  document_count: number;
  /** 创建时间（ISO 8601） */
  created_at: string;
  /** 更新时间（ISO 8601） */
  updated_at: string;
}

/** 创建分支请求 */
export interface CreateFolderRequest {
  name: string;
}

/** 更新分支请求 */
export interface UpdateFolderRequest {
  name?: string;
}

/** 分支列表响应 */
export interface FolderListResponse {
  items: DocumentFolder[];
  total: number;
}

/** 上传进度回调参数 */
export interface UploadProgress {
  /** 已上传字节 */
  loaded: number;
  /** 总字节 */
  total: number;
  /** 进度百分比（0-100） */
  percent: number;
}

/** 文档统计信息（对齐后端 /documents/stats/overview 响应） */
export interface DocumentStats {
  /** 文档总数 */
  total_documents: number;
  /** 已完成处理数 */
  completed: number;
  /** 处理中数 */
  processing: number;
  /** 处理失败数 */
  failed: number;
  /** 低质量数 */
  low_quality: number;
  /** 总分块数 */
  total_chunks: number;
  /** 总 Token 数 */
  total_tokens: number;
  /** 平均质量分 */
  avg_quality_score: number | null;
}

/** URL 导入请求参数 */
export interface ImportUrlParams {
  /** 网页 URL */
  url: string;
  /** 文档标题（可选） */
  title?: string;
  /** 文档分类，默认 "web" */
  category?: string;
  /** 可见性，默认 "private" */
  visibility?: DocumentVisibility;
}

// ============================================
// 批量操作相关类型（多选功能）
// ============================================

/** 批量删除请求 */
export interface BatchDeleteRequest {
  /** 要删除的文档ID列表 */
  document_ids: number[];
}

/** 批量移动请求 */
export interface BatchMoveRequest {
  /** 要移动的文档ID列表 */
  document_ids: number[];
  /** 目标分支ID（null 表示移出分支，归入未分类） */
  folder_id: number | null;
}

/** 批量操作响应 */
export interface BatchOperationResponse {
  /** 成功操作的文档数量 */
  success_count: number;
  /** 失败详情列表 */
  failed: { document_id: number; reason: string }[];
  /** 请求操作的文档总数 */
  total: number;
}

/** 未分类/默认分支的虚拟ID（哨兵值） */
export const UNCLASSIFIED_FOLDER_ID = 0;
