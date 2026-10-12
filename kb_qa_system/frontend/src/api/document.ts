/**
 * 文档相关 API 接口
 *
 * 作用：
 *   封装文档列表、上传、详情、删除、重新处理等接口调用。
 *   文档库分支管理接口已由后端实现（folders.py），以下为真实 API 调用。
 *
 * 对齐后端路由：kb_qa_system/backend/app/api/routes/documents.py、folders.py
 */

import { apiClient } from "./client";
import { API_PATHS } from "@/utils/constants";
import type {
  DocumentListResponse,
  DocumentResponse,
  DocumentQueryParams,
  UploadDocumentParams,
  TaskStatusResponse,
  DocumentFolder,
  CreateFolderRequest,
  UpdateFolderRequest,
  FolderListResponse,
  DocumentStats,
  ImportUrlParams,
  BatchOperationResponse,
} from "@/types/document";

/**
 * 获取文档列表
 *
 * 调用 GET /documents，支持分页、搜索、排序、状态筛选。
 *
 * @param params - 查询参数
 * @returns 文档列表响应
 */
export async function getDocuments(
  params: DocumentQueryParams = {},
): Promise<DocumentListResponse> {
  // 构建查询字符串
  const query = new URLSearchParams();
  if (params.page) query.set("page", String(params.page));
  if (params.page_size) query.set("page_size", String(params.page_size));
  if (params.status) query.set("status", params.status);
  if (params.file_type) query.set("file_type", params.file_type);
  if (params.date_from) query.set("date_from", params.date_from);
  if (params.date_to) query.set("date_to", params.date_to);
  if (params.search) query.set("search", params.search);
  if (params.sort_by) query.set("sort_by", params.sort_by);
  if (params.sort_order) query.set("sort_order", params.sort_order);
  // [Bug-1 修复] 补充 folder_id 参数传递，确保按分支过滤文档
  // 注意：folder_id=0 表示"未分类"，必须用 !== undefined 判断（0 是 falsy）
  if (params.folder_id !== undefined) query.set("folder_id", String(params.folder_id));
  // 补充 scope 参数传递，支持"我的/公共/全部"文档范围切换
  if (params.scope) query.set("scope", params.scope);

  const queryString = query.toString();
  const endpoint = queryString
    ? `${API_PATHS.DOCUMENTS}?${queryString}`
    : API_PATHS.DOCUMENTS;

  return apiClient.get<DocumentListResponse>(endpoint);
}

/**
 * 获取文档详情
 *
 * @param id - 文档ID
 * @returns 文档信息
 */
export async function getDocumentDetail(
  id: number,
): Promise<DocumentResponse> {
  return apiClient.get<DocumentResponse>(API_PATHS.DOCUMENT_DETAIL(id));
}

/**
 * 删除文档
 *
 * @param id - 文档ID
 */
export async function deleteDocument(id: number): Promise<void> {
  await apiClient.delete(API_PATHS.DOCUMENT_DETAIL(id));
}

/**
 * 重新处理文档
 *
 * @param id - 文档ID
 * @returns 任务状态响应
 */
export async function reprocessDocument(
  id: number,
): Promise<TaskStatusResponse> {
  return apiClient.post<TaskStatusResponse>(
    API_PATHS.DOCUMENT_REPROCESS(id),
  );
}

/**
 * 移动文档到其他分支 / 切换文档库
 *
 * 调用 PATCH /documents/{id}/move?folder_id={folderId}&visibility={visibility}，
 * 将文档移动到指定分支，或移出分支，同时支持在公共/个人文档库之间迁移。
 *
 * folderId 三种语义：
 * - number（>0）：移动到指定分支
 * - null：移出分支（归入未分类），通过 folder_id=0 传递（URL 无法直接传 null）
 * - undefined：不修改分支（仅切换文档库时使用），不传 folder_id 参数
 *
 * 修复 Issue 6：添加移动文档到其他分支的功能
 * 修复问题3b：添加 visibility 参数，支持库间迁移
 * 修复422：folderId=undefined 被转为字符串 "undefined" 导致后端校验失败
 *
 * @param id - 文档ID
 * @param folderId - 目标分支ID（null=移出分支，undefined=不修改）
 * @param visibility - 目标文档库（private/public，不传则保持原库不变）
 * @returns 更新后的文档信息
 */
export async function moveDocument(
  id: number,
  folderId: number | null | undefined,
  visibility?: "private" | "public",
): Promise<DocumentResponse> {
  const params = new URLSearchParams();
  // folderId 语义处理：
  // - undefined（不修改分支）：不传 folder_id 参数，后端保持原值不变
  // - null（移出分支）：传 folder_id=0，后端将 0 视为 None（移出分支）
  //   原因：URLSearchParams 无法传 null 值；传 "null" 或空字符串会被 FastAPI 拒绝（422）
  // - number（移动到分支）：传 folder_id=具体数字
  if (folderId !== undefined) {
    params.set("folder_id", folderId === null ? "0" : String(folderId));
  }
  if (visibility) params.set("visibility", visibility);
  const query = params.toString() ? `?${params.toString()}` : "";
  return apiClient.patch<DocumentResponse>(
    `${API_PATHS.DOCUMENT_MOVE(id)}${query}`,
  );
}

/**
 * 批量删除文档（多选功能）
 *
 * 调用 POST /documents/batch-delete，一次性软删除多个文档。
 * 逐个校验权限，无权操作的文档记入 failed 列表。
 *
 * @param documentIds - 要删除的文档ID列表（1-100 个）
 * @returns 批量操作结果（成功数 + 失败详情）
 */
export async function batchDeleteDocuments(
  documentIds: number[],
): Promise<BatchOperationResponse> {
  return apiClient.post<BatchOperationResponse>(
    API_PATHS.DOCUMENT_BATCH_DELETE,
    { document_ids: documentIds },
  );
}

/**
 * 批量移动文档到分支 / 批量切换文档库（多选功能）
 *
 * 调用 POST /documents/batch-move，一次性将多个文档移动到目标分支或移出分支，
 * 同时支持批量在公共文档库与个人文档库之间迁移（修复问题3b）。
 *
 * @param documentIds - 要移动的文档ID列表（1-100 个）
 * @param folderId - 目标分支ID（null 表示移出分支，归入未分类；不传则保持各文档原分支不变）
 * @param visibility - 目标文档库（private/public，不传则保持各文档原库不变）
 * @returns 批量操作结果（成功数 + 失败详情）
 */
export async function batchMoveDocuments(
  documentIds: number[],
  folderId?: number | null,
  visibility?: "private" | "public",
): Promise<BatchOperationResponse> {
  // 修复问题3b：仅在 folderId 非 undefined 时包含 folder_id 字段
  // 作用：JSON body 中不包含 folder_id 字段时，后端不会修改分支归属，
  //       支持仅切换文档库而不动分支。
  const payload: Record<string, unknown> = { document_ids: documentIds };
  if (folderId !== undefined) {
    payload.folder_id = folderId;
  }
  if (visibility) {
    payload.visibility = visibility;
  }
  return apiClient.post<BatchOperationResponse>(
    API_PATHS.DOCUMENT_BATCH_MOVE,
    payload,
  );
}

/**
 * 上传文档
 *
 * 调用 POST /documents/upload，使用 multipart/form-data。
 * 支持上传进度回调和取消。
 *
 * @param params - 上传参数
 * @param onProgress - 上传进度回调
 * @param signal - AbortSignal，用于取消上传
 * @returns 文档信息
 * @throws {DOMException} 当通过 signal 取消时抛出 AbortError
 */
export async function uploadDocument(
  params: UploadDocumentParams,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
): Promise<DocumentResponse> {
  const formData = new FormData();
  formData.append("file", params.file);

  if (params.title) formData.append("title", params.title);
  if (params.category) formData.append("category", params.category);
  if (params.visibility) formData.append("visibility", params.visibility);
  // 修复问题3a：folder_id=0 是合法值（未分类哨兵），不能用 if(params.folder_id) 判断（0 是 falsy）
  // 必须用 !== undefined 判断，否则用户上传到"未分类"分支时 folder_id 不会被传递
  if (params.folder_id !== undefined) {
    formData.append("folder_id", String(params.folder_id));
  }
  // 文档重名/重传修复：传递冲突处理策略
  if (params.conflict_resolution) {
    formData.append("conflict_resolution", params.conflict_resolution);
  }

  return apiClient.upload<DocumentResponse>(
    API_PATHS.DOCUMENT_UPLOAD,
    formData,
    onProgress,
    signal,
  );
}

/**
 * 查询任务状态（轮询文档处理进度）
 *
 * 调用 GET /documents/{documentId}/task-status，按文档ID查询 Celery 任务状态。
 *
 * @param documentId - 文档ID
 * @returns 任务状态响应
 */
export async function getTaskStatus(
  documentId: number,
): Promise<TaskStatusResponse> {
  return apiClient.get<TaskStatusResponse>(
    API_PATHS.DOCUMENT_TASK_STATUS(documentId),
  );
}

/**
 * 获取文档统计信息
 *
 * 调用 GET /documents/stats/overview，返回当前用户可见范围内的文档统计。
 *
 * @param scope - 范围：accessible（默认）/ mine / public
 * @returns 文档统计信息
 */
export async function getDocumentStats(
  scope?: "accessible" | "mine" | "public",
): Promise<DocumentStats> {
  const query = scope ? `?scope=${scope}` : "";
  return apiClient.get<DocumentStats>(`${API_PATHS.DOCUMENT_STATS}${query}`);
}

/**
 * 从 URL 导入文档
 *
 * 调用 POST /documents/import-url，下载网页内容并创建文档。
 * 内置 SSRF 防护，后端会校验 URL 安全性。
 *
 * @param params - 导入参数（url + title + category + visibility）
 * @returns 新创建的文档信息
 */
export async function importFromUrl(
  params: ImportUrlParams,
): Promise<DocumentResponse> {
  const formData = new FormData();
  formData.append("url", params.url);
  if (params.title) formData.append("title", params.title);
  formData.append("category", params.category || "web");
  formData.append("visibility", params.visibility || "private");

  return apiClient.upload<DocumentResponse>(
    API_PATHS.DOCUMENT_URL,
    formData,
  );
}

// ============================================
// 文档库分支管理（真实 API 调用，对齐后端 folders.py）
// ============================================

/**
 * 获取文档库分支列表
 *
 * 调用 GET /documents/folders，返回当前用户创建的所有分支（含文档数量）。
 *
 * @returns 分支列表响应
 */
export async function getFolders(): Promise<FolderListResponse> {
  return apiClient.get<FolderListResponse>(API_PATHS.FOLDERS);
}

/**
 * 创建文档库分支
 *
 * 调用 POST /documents/folders，分支名在同一用户下唯一。
 *
 * @param data - 创建请求（name）
 * @returns 新建的分支
 */
export async function createFolder(
  data: CreateFolderRequest,
): Promise<DocumentFolder> {
  return apiClient.post<DocumentFolder>(API_PATHS.FOLDERS, data);
}

/**
 * 更新文档库分支（重命名）
 *
 * 调用 PATCH /documents/folders/{id}，修改分支名称。
 *
 * @param id - 分支ID
 * @param data - 更新请求
 * @returns 更新后的分支
 */
export async function updateFolder(
  id: number,
  data: UpdateFolderRequest,
): Promise<DocumentFolder> {
  return apiClient.patch<DocumentFolder>(API_PATHS.FOLDER_DETAIL(id), data);
}

/**
 * 删除文档库分支
 *
 * 调用 DELETE /documents/folders/{id}，分支内文档的 folder_id 置 NULL（不删除文档）。
 *
 * @param id - 分支ID
 */
export async function deleteFolder(id: number): Promise<void> {
  await apiClient.delete(API_PATHS.FOLDER_DETAIL(id));
}

/**
 * 获取分支内文档列表
 *
 * 调用 GET /documents/folders/{id}/documents，返回指定分支内的文档列表（分页）。
 *
 * @param id - 分支ID
 * @param page - 页码，默认 1
 * @param pageSize - 每页数量，默认 10
 * @returns 文档列表响应
 */
export async function getFolderDocuments(
  id: number,
  page: number = 1,
  pageSize: number = 10,
): Promise<DocumentListResponse> {
  const query = new URLSearchParams();
  query.set("page", String(page));
  query.set("page_size", String(pageSize));
  return apiClient.get<DocumentListResponse>(
    `${API_PATHS.FOLDER_DETAIL(id)}/documents?${query.toString()}`,
  );
}
