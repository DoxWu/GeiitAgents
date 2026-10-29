/**
 * 注册申请表单组件
 *
 * 作用：
 *   实现注册申请表单，用户填写邮箱（需二次确认）和用户名提交申请。
 *   包含表单校验和提交成功状态展示。
 *
 * 邮箱二次验证机制：
 *   用户需连续输入两次邮箱地址，前端进行一致性校验，
 *   防止因邮箱输入错误导致管理员收到错误的账号申请。
 *
 * 使用方式：
 *   <RegisterApplyForm onSuccess={() => setShowSuccess(true)} />
 */

import { useEffect, useState } from "react";
import { Mail, MailCheck, User, Send } from "lucide-react";
import { Button, Input } from "@/components/common";
import { useToastStore } from "@/store/toastStore";
import { submitRegisterApply } from "@/api/auth";
import { isValidEmail, validateUsername } from "@/utils/validate";
import { useUnsavedChanges } from "@/hooks/useUnsavedChanges";
import { listOrganizationCatalog, type OrganizationSummary } from "@/api/organizations";

/** RegisterApplyForm 组件属性 */
interface RegisterApplyFormProps {
  /** 提交成功回调 */
  onSuccess?: (email: string) => void;
}

/** 表单错误类型 */
interface FormErrors {
  email?: string;
  confirmEmail?: string;
  username?: string;
}

/** RegisterApplyForm 组件 */
export function RegisterApplyForm({ onSuccess }: RegisterApplyFormProps) {
  const toast = useToastStore();
  const [email, setEmail] = useState("");
  const [confirmEmail, setConfirmEmail] = useState("");
  const [username, setUsername] = useState("");
  const [organizations, setOrganizations] = useState<OrganizationSummary[]>([]);
  const [organizationId, setOrganizationId] = useState("");
  const [errors, setErrors] = useState<FormErrors>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    void listOrganizationCatalog().then(items => { if (active) setOrganizations(items); }).catch(() => { if (active) setOrganizations([]); });
    return () => { active = false; };
  }, []);

  // E5-03: 表单未保存提示 — 任一字段有值时视为 dirty
  const isDirty = email !== "" || confirmEmail !== "" || username !== "" || organizationId !== "";
  useUnsavedChanges(isDirty, "您有未保存的注册申请数据，确定要离开吗？");

  /** 校验表单 */
  function validate(): boolean {
    const newErrors: FormErrors = {};

    // 邮箱格式校验
    if (!email) {
      newErrors.email = "请输入邮箱";
    } else if (!isValidEmail(email)) {
      newErrors.email = "邮箱格式不正确";
    }

    // 邮箱确认校验（二次验证机制）
    if (!confirmEmail) {
      newErrors.confirmEmail = "请再次输入邮箱";
    } else if (email && confirmEmail !== email) {
      newErrors.confirmEmail = "两次输入的邮箱不一致";
    }

    // 用户名校验
    const usernameResult = validateUsername(username);
    if (!usernameResult.valid) {
      newErrors.username = usernameResult.message;
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }

  /** 提交申请 */
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    setLoading(true);
    try {
      await submitRegisterApply({ email, username, ...(organizationId ? { organization_id: Number(organizationId) } : {}) });
      toast.success("申请已提交", "请等待管理员审核");
      onSuccess?.(email);
    } catch (err) {
      toast.apiError("提交失败", err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Input
        label="邮箱"
        type="email"
        name="email"
        placeholder="请输入您的企业邮箱"
        value={email}
        onChange={(e) => {
          setEmail(e.target.value);
          if (errors.email) setErrors({ ...errors, email: undefined });
        }}
        error={errors.email}
        icon={<Mail className="h-4 w-4" />}
        hint="审核通过后，密码设置链接将发送至此邮箱"
        autoComplete="email"
        autoFocus
      />

      <Input
        label="确认邮箱"
        type="email"
        name="confirmEmail"
        placeholder="请再次输入您的企业邮箱"
        value={confirmEmail}
        onChange={(e) => {
          setConfirmEmail(e.target.value);
          if (errors.confirmEmail)
            setErrors({ ...errors, confirmEmail: undefined });
        }}
        error={errors.confirmEmail}
        icon={<MailCheck className="h-4 w-4" />}
        hint="请再次输入相同的邮箱地址以确保无误"
        autoComplete="email"
      />

      <Input
        label="用户名"
        type="text"
        name="username"
        placeholder="3-50个字符，支持字母、数字、中文"
        value={username}
        onChange={(e) => {
          setUsername(e.target.value);
          if (errors.username) setErrors({ ...errors, username: undefined });
        }}
        error={errors.username}
        icon={<User className="h-4 w-4" />}
        autoComplete="username"
      />

      <label className="block space-y-1 text-sm font-medium text-ink">
        <span>申请加入组织</span>
        <select className="w-full rounded border border-line bg-surface px-3 py-2 text-sm text-ink" value={organizationId} onChange={event => setOrganizationId(event.target.value)} disabled={loading}>
          <option value="">暂不加入组织</option>
          {organizations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>

      <label className="block space-y-1 text-sm font-medium text-ink">
        <span>申请加入组织</span>
        <select className="w-full rounded border border-line bg-surface px-3 py-2 text-sm text-ink" value={organizationId} onChange={event => setOrganizationId(event.target.value)} disabled={loading}>
          <option value="">暂不加入组织</option>
          {organizations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>

      <Button
        type="submit"
        fullWidth
        loading={loading}
        icon={<Send className="h-4 w-4" />}
      >
        提交注册申请
      </Button>
    </form>
  );
}
