/**
 * 文档列表组件
 *
 * 作用：
 *   展示文档列表，根据 store 状态显示不同的内容：
 *   - 加载中：骨架屏
 *   - 错误：错误状态 + 重试
 *   - 空列表：空状态提示
 *   - 有数据：文档项列表
 *
 * 使用方式：
 *   <DocumentList />
 *
 * E2-04 虚拟化评估：
 *   单用户文档通常 < 100 条，配合分页（pageSize=20）每页最多渲染 20 项，
 *   无需虚拟化。若数据量增长到 500+，考虑引入 @tanstack/react-virtual。
 */

import { FileText } from "lucide-react";
import { DocumentListSkeleton, EmptyState, ErrorState } from "@/components/common";
import { useDocumentStore } from "@/store/documentStore";
import { DocumentItem } from "./DocumentItem";

/** DocumentList 组件 */
export function DocumentList() {
  const {
    documents,
    loading,
    error,
    searchKeyword,
    documentFilters,
    loadDocuments,
    clearError,
  } = useDocumentStore();

  // 加载中：骨架屏
  if (loading) {
    return <DocumentListSkeleton count={5} />;
  }

  // 错误状态
  if (error) {
    return (
      <ErrorState
        message={error}
        onRetry={() => {
          clearError();
          loadDocuments();
        }}
      />
    );
  }

  // 空状态
  if (documents.length === 0) {
    const hasActiveFilters = Boolean(searchKeyword.trim()) || Object.values(documentFilters).some(Boolean);
    return (
      <EmptyState
        icon={<FileText className="h-8 w-8" />}
        title={searchKeyword ? "未找到匹配的文档" : hasActiveFilters ? "没有符合条件的文档" : "暂无文档"}
        description={
          searchKeyword
            ? `没有找到标题或文件名包含"${searchKeyword}"的文档。`
            : hasActiveFilters
              ? "请调整当前筛选条件。"
              : "点击上方上传按钮或拖拽文件到上传区添加文档"
        }
      />
    );
  }

  // 文档列表
  return (
    <div className="space-y-2">
      {documents.map((doc) => (
        <DocumentItem key={doc.id} document={doc} />
      ))}
    </div>
  );
}
