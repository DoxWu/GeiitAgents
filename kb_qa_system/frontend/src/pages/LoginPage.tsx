/**
 * 登录页面
 *
 * 作用：
 *   渲染登录表单，处理登录成功后的路由跳转。
 *   已登录用户自动重定向至文档管理页。
 */

import { useEffect, useRef, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Loader2, AlertTriangle } from "lucide-react";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { LoginForm } from "@/components/auth/LoginForm";
import { LoginDiagnostics } from "@/components/auth/LoginDiagnostics";
import { useAuthStore } from "@/store/authStore";
import { safeStorage } from "@/utils/safeStorage";

/** LoginPage 组件 */
export default function LoginPage() {
  const navigate = useNavigate();
  const { isAuthenticated, error, guestLogin, loading, loginDiagnostic } = useAuthStore();
  const [guestLoading, setGuestLoading] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  // 存储降级提示（国产浏览器隐私模式阻止 localStorage 时显示）
  const storageWarning = safeStorage.getDegradedMessage();

  // 已登录则重定向
  useEffect(() => {
    if (isAuthenticated) {
      navigate("/documents", { replace: true });
    }
  }, [isAuthenticated, navigate]);

  /** 登录成功回调 */
  function handleLoginSuccess() {
    navigate("/documents", { replace: true });
  }

  /** 游客登录处理 */
  async function handleGuestLogin() {
    setGuestLoading(true);
    try {
      await guestLogin();
      if (mounted.current) navigate("/chat", { replace: true });
    } catch {
      // 错误已由 store 设置到 error 字段
    } finally {
      if (mounted.current) setGuestLoading(false);
    }
  }

  return (
    <AuthLayout
      title="登录"
      subtitle="登录账号以使用获授权的云端服务；本机模型和自购 API 无需登录"
      footer={
        <p className="text-sm text-ink-secondary">
          还没有账号？{" "}
          <Link
            to="/register"
            className="font-medium text-brand hover:text-brand-hover"
          >
            申请注册
          </Link>
        </p>
      }
    >
      {/* 存储降级警告（国产浏览器隐私模式阻止 localStorage 时显示） */}
      {storageWarning && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" />
          <p className="text-sm text-amber-700">{storageWarning}</p>
        </div>
      )}
      {/* 全局错误提示（来自 store） */}
      {error && (
        <div className="mb-4 rounded-lg border border-danger/20 bg-red-50 px-4 py-2.5">
          <p className="text-sm text-danger">{error}</p>
        </div>
      )}
      <LoginForm onSuccess={handleLoginSuccess} onValidationFailure={() => useAuthStore.setState({ loginDiagnostic: null })} />
      <LoginDiagnostics attempt={loginDiagnostic} />

      {/* 分割线 */}
      <div className="relative my-4">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t border-line" />
        </div>
        <div className="relative flex justify-center text-xs">
          <span className="bg-surface px-2 text-ink-tertiary">或</span>
        </div>
      </div>

      {/* 游客登录按钮 */}
      <button
        type="button"
        onClick={handleGuestLogin}
        disabled={guestLoading || loading}
        className="w-full rounded-lg border border-line bg-surface py-2.5 text-sm font-medium text-ink-secondary transition hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50"
      >
        {guestLoading ? (
          <Loader2 className="mx-auto h-4 w-4 animate-spin" />
        ) : (
          "游客登录（限 20 次提问）"
        )}
      </button>
    </AuthLayout>
  );
}
