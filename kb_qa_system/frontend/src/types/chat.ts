/**
 * 聊天相关类型定义
 *
 * 作用：
 *   定义对话、问答、流式输出等相关的 TypeScript 类型，
 *   与后端 schemas/chat.py 中的 Pydantic Schema 对齐。
 *
 * 对齐后端文件：kb_qa_system/backend/app/schemas/chat.py
 */

/** SSE 流式事件类型 */
export type StreamChunkType = "sources" | "chunk" | "done" | "error";

/** 消息角色 */
export type MessageRole = "user" | "assistant";

/** 引用来源项（对齐后端 SourceItem Schema） */
export interface SourceItem {
  /** 文档ID */
  document_id?: number;
  /** 文档标题 */
  title: string;
  /** 引用内容片段 */
  content: string;
  /** 相关度分数（0-1） */
  score: number;
}

/** 提问请求（对齐后端 QuestionRequest Schema） */
export interface QuestionRequest {
  rerank_mode?: import('@/services/rerankPreference').RerankMode;
  /** 问题内容（1-2000 字符） */
  question: string;
  /** 会话ID，不填则创建新会话 */
  conversation_id?: number;
  /** 是否使用流式响应 */
  stream?: boolean;
  /** 幂等性键，防止重复提交（1-100，仅含字母数字及 - _ 字符） */
  idempotency_key?: string;
}

/** 重新生成请求（对齐后端 RegenerateRequest Schema） */
export interface RegenerateRequest {
  rerank_mode?: import('@/services/rerankPreference').RerankMode;
  /** 会话ID（必填，正整数） */
  conversation_id: number;
  /** 要重新生成的 AI 消息ID（可选，不填则默认重新生成最后一条 AI 消息） */
  message_id?: number;
  /** 幂等性键，防止重复提交 */
  idempotency_key?: string;
}

/** 回答响应（对齐后端 AnswerResponse Schema） */
export interface AnswerResponse {
  /** 回答内容 */
  answer: string;
  /** 引用来源列表 */
  sources: SourceItem[];
  /** 对话ID */
  conversation_id: number;
  /** 消息ID */
  message_id?: number;
  /** 是否降级兜底回复 */
  degraded: boolean;
  /** 降级原因 */
  degrade_reason?: string;
}

/** 消息响应（对齐后端 MessageResponse Schema） */
export interface ChatMessage {
  /** 消息ID */
  id: number;
  /** 角色：user 用户 / assistant AI */
  role: MessageRole;
  /** 消息内容 */
  content: string;
  /** 引用来源（仅 assistant 消息有） */
  sources?: SourceItem[] | null;
  /** 创建时间（ISO 8601） */
  created_at: string;
  /** 是否降级兜底回复 */
  is_degraded?: boolean;
  /** 降级原因 */
  degrade_reason?: string;
  /** 是否为重新生成的消息 */
  is_regenerated?: boolean;
}

/** 对话响应（对齐后端 ConversationResponse Schema） */
export interface Conversation {
  /** 对话ID */
  id: number;
  /** 对话标题 */
  title: string;
  /** 是否活跃（软删除标记） */
  is_active: boolean;
  /** 创建时间（ISO 8601） */
  created_at: string;
  /** 更新时间（ISO 8601） */
  updated_at: string;
  /** 消息列表（获取详情时包含） */
  messages?: ChatMessage[];
}

/** 对话列表响应（对齐后端 ConversationListResponse Schema） */
export interface ConversationListResponse {
  /** 对话列表 */
  items: Conversation[];
  /** 总数 */
  total: number;
  /** 当前页码 */
  page: number;
  /** 每页数量 */
  page_size: number;
}
