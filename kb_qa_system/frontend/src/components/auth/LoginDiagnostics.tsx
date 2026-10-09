import type { LoginDiagnostic } from '@/services/loginDiagnostics';

export function LoginDiagnostics({ attempt }: { attempt: LoginDiagnostic | null | undefined }) {
  if (!attempt) return <p role="status" className="mt-4 text-xs text-ink-secondary">尚未发起登录请求；邮箱和密码校验通过后才会发送。</p>;
  const heading = attempt.phase === 'sending' ? '正在发起登录请求…' : attempt.phase === 'http-response' ? `服务器已响应：HTTP ${attempt.status}` : attempt.phase === 'succeeded' ? '登录成功' : attempt.phase === 'cancelled' ? '登录请求已取消' : attempt.phase === 'timeout' ? '登录请求超时（20 秒）' : '未取得可读取的 HTTP 响应';
  return <section aria-label="登录请求诊断" role="status" className="mt-4 grid gap-2 rounded-lg border border-line bg-canvas p-3 text-xs">
    <p className="font-medium text-sm">{heading}</p>
    <p className="break-all">请求：POST {attempt.url}</p>
    <p>发起时间：{new Date(attempt.startedAt).toLocaleString()}{attempt.durationMs !== undefined ? ` · 用时 ${(attempt.durationMs / 1000).toFixed(1)} 秒` : ''}</p>
    {attempt.requestId && <p className="break-all">请求编号：{attempt.requestId}</p>}
    {(attempt.phase === 'no-response' || attempt.phase === 'timeout') && <>
      <p>客户端已尝试发起请求，HTTP 状态码不可用。无法确认服务器是否收到登录 POST；跨域预检、网络、DNS、TLS 或重定向限制都可能造成这种情况。</p>
      <p>请核对上方请求地址。若地址正确，可检查网络，并让服务器管理员按发起时间检查访问日志和 CORS 配置。</p>
    </>}
    {attempt.status === 401 && <p>服务器拒绝了登录，请核对账号、密码及所选账号服务器。</p>}
    {attempt.status === 403 && <p>服务器拒绝访问，请检查账号权限或服务端访问规则。</p>}
    {attempt.status === 404 && <p>登录接口不存在，请检查账号服务器地址和反向代理的 API 路径。</p>}
    {attempt.status === 429 && <p>请求过于频繁，请稍后再试。</p>}
    {attempt.status && attempt.status >= 500 && <p>服务器或网关发生错误，可按状态码、发起时间和请求编号检查服务端日志。</p>}
  </section>;
}
