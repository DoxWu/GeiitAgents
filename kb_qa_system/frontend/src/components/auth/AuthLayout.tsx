import { AccountServerSelector } from './AccountServerSelector';
/**
 * 认证页面布局组件
 *
 * 作用：
 *   为登录、注册申请、密码设置等认证页面提供统一的居中布局。
 *   包含品牌标题和卡片容器。
 *
 * 使用方式：
 *   <AuthLayout title="登录" subtitle="欢迎回来">
 *     <LoginForm />
 *   </AuthLayout>
 */

import { BookOpen } from "lucide-react";
import { Link } from "react-router-dom";

/** AuthLayout 组件属性 */
interface AuthLayoutProps {
  /** 页面标题 */
  title: string;
  /** 副标题 */
  subtitle?: string;
  /** 子内容 */
  children: React.ReactNode;
  /** 底部区域（如切换链接） */
  footer?: React.ReactNode;
}

/** AuthLayout 组件 */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: AuthLayoutProps) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-8">
      <div className="w-full max-w-md animate-slide-up">
        {/* 品牌标题 */}
        <div className="mb-8 text-center">
          <div className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-lg bg-brand text-white">
            <BookOpen className="h-6 w-6" />
          </div>
          <h1 className="text-xl font-semibold text-ink">
            GeiIt企业知识库
          </h1>
          {subtitle && (
            <p className="mt-1 text-sm text-ink-secondary">{subtitle}</p>
          )}
        </div>

        {/* 卡片容器 */}
        <div className="rounded-lg border border-line bg-surface p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-ink">{title}</h2>
          <Link to="/workbench" className="mb-4 block text-sm text-brand" aria-label="关闭登录并返回工作台">关闭 / 返回工作台（无需登录）</Link>
          <AccountServerSelector />
          {children}
        </div>

        {/* 底部区域 */}
        {footer && <div className="mt-4 text-center">{footer}</div>}

        {/* 隐私政策与用户协议链接（合规要求，始终展示） */}
        <div className="mt-6 flex items-center justify-center gap-3 text-center">
          <Link
            to="/privacy"
            className="text-xs text-ink-tertiary transition-colors hover:text-brand"
          >
            隐私政策
          </Link>
          <span className="text-xs text-ink-tertiary">·</span>
          <Link
            to="/terms"
            className="text-xs text-ink-tertiary transition-colors hover:text-brand"
          >
            用户协议
          </Link>
        </div>
      </div>
    </div>
  );
}
