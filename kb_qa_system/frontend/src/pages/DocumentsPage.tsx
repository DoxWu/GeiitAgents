/**
 * 文档管理主页面
 *
 * 作用：
 *   知识库管理系统的核心页面，采用三栏布局：
 *   - 左侧：文档库分支侧边栏
 *   - 中间：文档列表区（含搜索、排序、上传）
 *   - 右侧：文档预览面板（按需展开）
 *
 * 使用方式：
 *   <DocumentsPage />  // 由路由 /documents 渲染
 */

import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Menu, Globe, Lock, CheckSquare } from "lucide-react";
import { Sidebar } from "@/components/documents/Sidebar";
import { DocumentList } from "@/components/documents/DocumentList";
import { DocumentPreview } from "@/components/documents/DocumentPreview";
import { SearchBar } from "@/components/documents/SearchBar";
import { DocumentFilters } from "@/components/documents/DocumentFilters";
import { SortDropdown } from "@/components/documents/SortDropdown";
import { UploadZone } from "@/components/documents/UploadZone";
import { Pagination } from "@/components/documents/Pagination";
import { StatsPanel } from "@/components/documents/StatsPanel";
import { UrlImportModal } from "@/components/documents/UrlImportModal";
import { BatchActionBar } from "@/components/documents/BatchActionBar";
import { Button } from "@/components/common/Button";
import { useDocumentStore } from "@/store/documentStore";
import { useAuthStore } from "@/store/authStore";
import { cn } from "@/lib/utils";

/** DocumentsPage 组件 */
export default function DocumentsPage() {
  const {
    folders,
    currentFolderId,
    currentScope,
    searchKeyword,
    documentFilters,
    documents,
    total,
    page,
    pageSize,
    selectionMode,
    enterSelectionMode,
    loadFolders,
    loadDocuments,
    selectFolder,
    setPage,
    stopAllPolling,
  } = useDocumentStore();

  // 获取当前登录用户（用于判断游客身份）
  // 作用：guest 用户无权上传/导入文档，需隐藏上传入口并提示
  const { user } = useAuthStore();
  const isGuest = user?.user_type === "guest";

  // 从 URL 读取 folderId 参数（支持 /documents/:folderId 路由）
  const { folderId } = useParams<{ folderId: string }>();

  // 移动端侧边栏折叠状态
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // URL 导入弹窗状态
  const [urlImportOpen, setUrlImportOpen] = useState(false);

  // 加载分支列表
  // 修复问题三：依赖 user?.id 确保账户切换时重新加载分支列表。
  // 原实现 useEffect([]) 仅在挂载时执行，若 loadFolders 静默失败或
  // 组件因 React 复用未重新挂载，用户切换账户后分支列表不会刷新。
  // 依赖 user?.id：用户登录时 user 从 null → 有值，触发重新加载。
  useEffect(() => {
    if (user?.id) {
      loadFolders();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // URL folderId 变化时，同步选中分支并加载文档
  // E3-03: 仅依赖 URL 参数 folderId 变化触发。
  // currentFolderId/selectFolder/loadDocuments 来自 store，
  // 引用稳定但 lint 无法识别；加入依赖会导致 URL 变化时重复触发。
  useEffect(() => {
    if (folderId !== undefined) {
      const id = Number(folderId);
      if (!Number.isNaN(id) && id !== currentFolderId) {
        selectFolder(id);
        return;
      }
    } else if (currentFolderId !== null && folderId === undefined) {
      // 从 /documents/:folderId 回到 /documents 时，清除分支选择
      selectFolder(null);
      return;
    }
    // 正常加载文档列表
    loadDocuments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId]);

  // 组件卸载时停止所有轮询，避免内存泄漏
  // E3-03: 仅在挂载时注册 cleanup 函数。stopAllPolling 来自 store，
  // 引用稳定但 lint 无法识别；加入依赖会导致 cleanup 提前执行。
  useEffect(() => {
    return () => {
      stopAllPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 当前分支名称（修复 Issue 8：根据范围显示不同标题） */
  const scopeLabels: Record<string, string> = {
    accessible: "全部文档",
    mine: "个人文档库",
    public: "公共文档库",
  };
  // folder_id=0 表示"未分类"虚拟分支
  const currentFolderName =
    currentFolderId !== null
      ? currentFolderId === 0
        ? "未分类"
        : folders.find((f) => f.id === currentFolderId)?.name || "文档库"
      : scopeLabels[currentScope] || "全部文档";

  /** 是否为空列表（显示完整上传区） */
  const hasActiveFilters = Boolean(searchKeyword.trim()) || Object.values(documentFilters).some(Boolean);
  const showFullUploadZone = documents.length === 0 && total === 0 && !hasActiveFilters;

  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      {/* 侧边栏 - 桌面端固定，移动端抽屉 */}
      <div
        className={cn(
          "fixed inset-0 z-50 lg:static lg:z-auto",
          sidebarOpen ? "block" : "hidden lg:block",
        )}
      >
        {/* 移动端遮罩 */}
        {/* 修复：bg-black/50 在高缩放比例下仍与背景过度融合，提升至 bg-black/70 确保侧边栏清晰分离 */}
        {sidebarOpen && (
          <div
            className="absolute inset-0 bg-black/70 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        {/* 修复：wrapper 添加 bg-surface 确保侧边栏区域完全不透明，不依赖内部 aside 的背景 */}
        {/* 移动端优化：添加 mobile-solid-bg，在 <768px 时强制纯白/纯黑背景 */}
        <div className="relative h-full w-60 bg-surface mobile-solid-bg">
          <Sidebar
            collapsed={!sidebarOpen}
            onCollapse={() => setSidebarOpen(false)}
          />
        </div>
      </div>

      {/* 主内容区 */}
      <main className="flex flex-1 flex-col overflow-hidden">
        {/* 顶部工具栏 */}
        <header className="border-b border-line bg-surface px-4 py-3 lg:px-6">
          <div className="flex items-center gap-3">
            {/* 移动端菜单按钮 */}
            <button
              onClick={() => setSidebarOpen(true)}
              className="rounded p-1.5 text-ink-secondary hover:bg-muted lg:hidden"
              aria-label="打开侧边栏"
            >
              <Menu className="h-5 w-5" />
            </button>

            {/* 页面标题 */}
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold text-ink">
                {currentFolderName}
              </h1>
              {total > 0 && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-ink-secondary">
                  {total}
                </span>
              )}
            </div>

            {/* 搜索框 */}
            <div className="ml-auto hidden sm:block">
              <SearchBar />
            </div>

            {/* 排序 */}
            <SortDropdown />

            {/* 多选按钮（有文档时显示，多选模式下隐藏） */}
            {!selectionMode && documents.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                icon={<CheckSquare className="h-4 w-4" />}
                onClick={enterSelectionMode}
              >
                多选
              </Button>
            )}

            {/* 上传按钮 / 游客无权提交提示 */}
            {isGuest ? (
              <span
                className="flex items-center gap-1.5 rounded-md bg-muted px-3 py-1.5 text-xs text-ink-secondary"
                title="游客账号无权上传文档，请注册账号后使用"
              >
                <Lock className="h-3.5 w-3.5" />
                游客无权提交
              </span>
            ) : (
              <UploadZone
                folderId={currentFolderId}
                scope={currentScope}
                compact
              />
            )}

            {/* URL 导入按钮（游客隐藏） */}
            {!isGuest && (
              <Button
                variant="secondary"
                size="sm"
                icon={<Globe className="h-4 w-4" />}
                onClick={() => setUrlImportOpen(true)}
              >
                URL 导入
              </Button>
            )}
          </div>

          {/* 移动端搜索框 */}
          <div className="mt-2 sm:hidden">
            <SearchBar />
          </div>
          <div className="mt-3">
            <DocumentFilters />
            <p className="mt-2 text-xs text-ink-tertiary">搜索匹配标题或原始文件名，不搜索正文；创建日期含起止当天，按服务端存储日期筛选。</p>
          </div>
        </header>

        {/* 文档列表区 */}
        <div className="flex-1 overflow-y-auto p-4 lg:p-6">
          {/* 空列表时显示完整上传区 / 游客无权提交提示 */}
          {showFullUploadZone ? (
            isGuest ? (
              <div className="mx-auto max-w-2xl">
                <div className="flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-line bg-surface py-12 text-center">
                  <Lock className="h-10 w-10 text-ink-tertiary" />
                  <div>
                    <p className="text-sm font-medium text-ink">
                      游客账号无权提交文档
                    </p>
                    <p className="mt-1 text-xs text-ink-tertiary">
                      游客为只读账号，仅可浏览公共文档库并提问（限 20 次）。
                      <br />
                      如需上传文档，请注册正式账号后登录。
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mx-auto max-w-2xl">
                <UploadZone
                  folderId={currentFolderId}
                  scope={currentScope}
                />
              </div>
            )
          ) : (
            <div className="mx-auto max-w-4xl space-y-4">
              {/* 多选模式下的批量操作工具栏 */}
              {selectionMode && <BatchActionBar />}
              {/* 文档统计面板 */}
              <StatsPanel scope={currentScope} />
              <DocumentList />
              {/* 分页控件：文档总数超过每页数量时显示 */}
              {total > pageSize && (
                <Pagination
                  current={page}
                  pageSize={pageSize}
                  total={total}
                  onChange={setPage}
                />
              )}
            </div>
          )}
        </div>
      </main>

      {/* 文档预览面板 */}
      <DocumentPreview />

      {/* URL 导入弹窗 */}
      <UrlImportModal
        open={urlImportOpen}
        onClose={() => setUrlImportOpen(false)}
        folderId={currentFolderId}
        onSuccess={() => loadDocuments()}
      />
    </div>
  );
}
