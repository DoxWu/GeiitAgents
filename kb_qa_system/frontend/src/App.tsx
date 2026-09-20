/**
 * 应用根组件
 *
 * 作用：
 *   配置路由表、全局 Toast 容器、错误边界。
 *   路由结构：
 *   - /login            → 登录页（已登录则重定向至 /documents）
 *   - /register          → 注册申请页（已登录则重定向至 /documents）
 *   - /set-password      → 设置密码页（已登录则重定向至 /documents）
 *   - /documents         → 文档管理页（受保护）
 *   - /documents/:folderId → 指定分支的文档管理页（受保护）
 *   - /                  → 重定向至 /documents
 *   - *                  → 404 页面
 *
 * 性能优化：
 *   除 LoginPage 和 NotFoundPage（首屏 critical）外，所有页面使用 React.lazy 懒加载，
 *   减小首屏 bundle 体积，页面按需加载。
 *
 * 使用方式：
 *   由 main.tsx 渲染
 */

import { lazy, Suspense } from "react";
import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import { ToastContainer, ErrorBoundary, OfflineIndicator, Spinner } from "@/components/common";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { PublicRoute } from "@/components/auth/PublicRoute";
import { AdminRoute } from "@/components/auth/AdminRoute";
// 静态导入：首屏 critical path（登录页 + 404 页，体积小且需立即可用）
import LoginPage from "@/pages/LoginPage";
import NotFoundPage from "@/pages/NotFoundPage";
// 懒加载：按路由按需加载，减小首屏 bundle
const RegisterApplyPage = lazy(() => import("@/pages/RegisterApplyPage"));
const SetPasswordPage = lazy(() => import("@/pages/SetPasswordPage"));
const DocumentsPage = lazy(() => import("@/pages/DocumentsPage"));
const ChatPage = lazy(() => import("@/pages/ChatPage"));
const SettingsPage = lazy(() => import("@/pages/SettingsPage"));
const AdminApplicationsPage = lazy(() => import("@/pages/AdminApplicationsPage"));
const PrivacyPage = lazy(() => import("@/pages/PrivacyPage"));
const TermsPage = lazy(() => import("@/pages/TermsPage"));
const HelpPage = lazy(() => import("@/pages/HelpPage"));
const WorkbenchPage = lazy(() => import("@/pages/WorkbenchPage"));
const LocalKnowledgePage = lazy(() => import("@/pages/LocalKnowledgePage"));
const BackupRecoveryPage = lazy(() => import("@/pages/BackupRecoveryPage"));
import { useAuthStore } from "@/store/authStore";
import { useNotification } from "@/hooks/useNotification";

/** 页面加载占位组件（懒加载 fallback） */
function PageFallback() {
  return (
    <div className="flex min-h-[400px] items-center justify-center">
      <Spinner size="lg" />
    </div>
  );
}

/** 登录页重定向组件（已登录用户访问 /login 时重定向至 /documents） */
function LoginRoute() {
  const { isAuthenticated } = useAuthStore();

  if (isAuthenticated) {
    return <Navigate to="/documents" replace />;
  }
  return <LoginPage />;
}

/** App 根组件 */
export default function App() {
  // E1-04: WebSocket 实时通知（全局生效，仅认证用户建立连接）
  useNotification();

  return (
    <ErrorBoundary>
      <Router>
        {/* E5-02: 离线状态提示（全局生效） */}
        <OfflineIndicator />
        {/* 懒加载 Suspense 包裹：页面 chunk 加载期间显示 PageFallback */}
        <Suspense fallback={<PageFallback />}>
        <Routes>
          {/* 根路径重定向至文档管理页 */}
          <Route path="/" element={<Navigate to={"__TAURI_INTERNALS__" in window ? "/workbench" : "/documents"} replace />} />
          <Route path="/workbench" element={<WorkbenchPage />} />
          <Route path="/local-knowledge" element={<LocalKnowledgePage />} />
          <Route path="/admin/backup-recovery" element={<AdminRoute><BackupRecoveryPage /></AdminRoute>} />

          {/* 认证相关页面（已登录用户重定向至 /documents） */}
          <Route path="/login" element={<LoginRoute />} />
          <Route
            path="/register"
            element={
              <PublicRoute>
                <RegisterApplyPage />
              </PublicRoute>
            }
          />
          <Route
            path="/set-password"
            element={
              <PublicRoute>
                <SetPasswordPage />
              </PublicRoute>
            }
          />
          {/* 隐私政策页面（公开访问，无需登录） */}
          <Route path="/privacy" element={<PrivacyPage />} />
          {/* 用户协议页面（公开访问，无需登录） */}
          <Route path="/terms" element={<TermsPage />} />
          {/* 帮助文档页面（D10-02，公开访问，无需登录） */}
          <Route path="/help" element={<HelpPage />} />

          {/* 受保护页面 */}
          <Route
            path="/documents"
            element={
              <ProtectedRoute>
                <DocumentsPage />
              </ProtectedRoute>
            }
          />
          {/* 指定分支的文档管理页（直接访问指定文档库分支） */}
          <Route
            path="/documents/:folderId"
            element={
              <ProtectedRoute>
                <DocumentsPage />
              </ProtectedRoute>
            }
          />
          {/* 设置页面（账号管理、删除账号） */}
          <Route
            path="/settings"
            element={
              <ProtectedRoute>
                <SettingsPage />
              </ProtectedRoute>
            }
          />
          {/* 聊天页面（问答对话） */}
          <Route
            path="/chat"
            element={
              <ProtectedRoute>
                <ChatPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/chat/:conversationId"
            element={
              <ProtectedRoute>
                <ChatPage />
              </ProtectedRoute>
            }
          />
          {/* 管理员页面（注册申请管理） */}
          <Route
            path="/admin/applications"
            element={
              <AdminRoute>
                <AdminApplicationsPage />
              </AdminRoute>
            }
          />

          {/* 404 页面 */}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
        </Suspense>

        {/* 全局 Toast 通知容器 */}
        <ToastContainer />
      </Router>
    </ErrorBoundary>
  );
}
