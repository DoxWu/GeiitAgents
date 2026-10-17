/**
 * 删除账号确认弹窗
 *
 * 作用：
 *   在用户确认删除账号时弹出，要求输入密码和用户名二次确认，
 *   防止误操作。删除成功后跳转登录页。
 *
 * 使用方式：
 *   <DeleteAccountModal
 *     open={isOpen}
 *     onClose={() => setOpen(false)}
 *     username={user.username}
 *   />
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { Modal } from "@/components/common/Modal";
import { Button } from "@/components/common/Button";
import { Input } from "@/components/common/Input";
import { useAuthStore } from "@/store/authStore";
import { useToastStore } from "@/store/toastStore";

/** DeleteAccountModal 组件属性 */
interface DeleteAccountModalProps {
  /** 是否打开 */
  open: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /** 当前用户名（用于二次确认） */
  username: string;
}

/** DeleteAccountModal 组件 */
export function DeleteAccountModal({
  open,
  onClose,
  username,
}: DeleteAccountModalProps) {
  const navigate = useNavigate();
  const { deleteAccount } = useAuthStore();
  const { success, error: errorToast } = useToastStore();

  /** 密码输入值 */
  const [password, setPassword] = useState("");
  /** 用户名确认输入值 */
  const [usernameConfirm, setUsernameConfirm] = useState("");
  /** 错误信息 */
  const [error, setError] = useState<string | null>(null);
  /** 提交中 */
  const [submitting, setSubmitting] = useState(false);

  /** 用户名是否匹配（二次确认校验） */
  const usernameMatched = usernameConfirm === username;
  /** 密码是否非空 */
  const passwordFilled = password.length > 0;
  /** 是否可提交（密码非空 + 用户名匹配 + 未在提交中） */
  const canSubmit = passwordFilled && usernameMatched && !submitting;

  /** 重置表单状态 */
  const resetForm = () => {
    setPassword("");
    setUsernameConfirm("");
    setError(null);
    setSubmitting(false);
  };

  /** 关闭弹窗（重置状态） */
  const handleClose = () => {
    if (submitting) return; // 提交中禁止关闭
    resetForm();
    onClose();
  };

  /** 提交删除账号 */
  const handleSubmit = async () => {
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);

    try {
      await deleteAccount(password);
      success("账号已删除", "在线关联记录已移除；服务器文件清理可能异步完成，既有备份、已发送邮件和本机数据不会由此删除。");
      resetForm();
      onClose();
      // 跳转登录页
      navigate("/login", { replace: true });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "删除账号失败，请重试";
      setError(message);
      errorToast("删除账号失败", message);
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="删除账号"
      disableBackdropClose={submitting}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={handleClose}
            disabled={submitting}
          >
            取消
          </Button>
          <Button
            variant="danger"
            onClick={handleSubmit}
            loading={submitting}
            disabled={!canSubmit}
          >
            确认删除
          </Button>
        </>
      }
    >
      {/* 警告区 */}
      <div className="mb-4 flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-warning" />
        <div className="text-sm text-ink-secondary">
          <p className="font-medium text-ink">此操作不可恢复</p>
          <p className="mt-1">
            删除后，在线账号及关联记录将被移除，服务器文件清理可能异步完成。
            既有备份、已发送邮件和本机数据不会由此删除；请先导出或备份重要数据。
          </p>
        </div>
      </div>

      {/* 确认说明 */}
      <div className="mb-4 space-y-1 text-sm text-ink-secondary">
        <p>为防止误操作，请完成以下确认：</p>
        <p>
          1. 输入当前账号密码以验证身份
        </p>
        <p>
          2. 输入用户名{" "}
          <span className="font-semibold text-ink">{username}</span>{" "}
          以确认删除
        </p>
      </div>

      {/* 密码输入 */}
      <div className="mb-4">
        <Input
          label="密码"
          type="password"
          name="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="请输入当前账号密码"
          disabled={submitting}
          autoComplete="current-password"
        />
      </div>

      {/* 用户名确认输入 */}
      <div className="mb-2">
        <Input
          label="确认用户名"
          type="text"
          name="usernameConfirm"
          value={usernameConfirm}
          onChange={(e) => setUsernameConfirm(e.target.value)}
          placeholder={`请输入 ${username}`}
          disabled={submitting}
          error={
            usernameConfirm && !usernameMatched
              ? "用户名不匹配"
              : undefined
          }
        />
      </div>

      {/* 错误提示 */}
      {error && (
        <p className="mt-3 text-sm text-danger" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
