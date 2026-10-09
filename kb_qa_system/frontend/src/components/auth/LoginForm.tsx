/**
 * 登录表单组件
 *
 * 作用：
 *   实现邮箱+密码登录表单，包含：
 *   - 邮箱格式实时校验
 *   - 密码显示/隐藏切换
 *   - 表单错误提示
 *   - 登录提交（调用 authStore.login）
 *   - 登录成功后跳转（通过 onSuccess 回调）
 *
 * 使用方式：
 *   <LoginForm onSuccess={() => navigate('/documents')} />
 */

import { useEffect, useRef, useState } from "react";
import { Mail, Lock, Eye, EyeOff, LogIn } from "lucide-react";
import { Button, Input } from "@/components/common";
import { useAuthStore } from "@/store/authStore";
import { isValidEmail } from "@/utils/validate";

/** LoginForm 组件属性 */
interface LoginFormProps {
  /** 登录成功回调 */
  onSuccess?: () => void;
  onValidationFailure?: () => void;
}

/** 登录表单错误类型 */
interface FormErrors {
  email?: string;
  password?: string;
}

/** LoginForm 组件 */
export function LoginForm({ onSuccess, onValidationFailure }: LoginFormProps) {
  const { login, loading } = useAuthStore();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});

  /** 校验表单
   * @returns 是否校验通过
   */
  function validate(): boolean {
    const newErrors: FormErrors = {};

    if (!email) {
      newErrors.email = "请输入邮箱";
    } else if (!isValidEmail(email)) {
      newErrors.email = "邮箱格式不正确";
    }

    if (!password) {
      newErrors.password = "请输入密码";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }

  /** 提交登录 */
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) { onValidationFailure?.(); return; }

    try {
      // 后端 username 字段同时支持用户名和邮箱
      // 前端登录表单使用邮箱，将其作为 username 传入
      await login({ username: email, password });
      if (mounted.current) onSuccess?.();
    } catch {
      // 错误已在 store 中处理，此处无需额外处理
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Input
        label="邮箱"
        type="email"
        name="email"
        placeholder="请输入您的邮箱"
        value={email}
        onChange={(e) => {
          setEmail(e.target.value);
          if (errors.email) setErrors({ ...errors, email: undefined });
        }}
        error={errors.email}
        icon={<Mail className="h-4 w-4" />}
        autoComplete="email"
        autoFocus
      />

      <Input
        label="密码"
        type={showPassword ? "text" : "password"}
        name="password"
        placeholder="请输入密码"
        value={password}
        onChange={(e) => {
          setPassword(e.target.value);
          if (errors.password) setErrors({ ...errors, password: undefined });
        }}
        error={errors.password}
        icon={<Lock className="h-4 w-4" />}
        rightIcon={
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            className="transition-colors hover:text-ink"
            aria-label={showPassword ? "隐藏密码" : "显示密码"}
          >
            {showPassword ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </button>
        }
        autoComplete="current-password"
      />

      <Button
        type="submit"
        fullWidth
        loading={loading}
        icon={<LogIn className="h-4 w-4" />}
      >
        登录
      </Button>
    </form>
  );
}
