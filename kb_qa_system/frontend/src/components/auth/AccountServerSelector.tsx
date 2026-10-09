import { useState } from 'react';
import { DEFAULT_ACCOUNT_SERVER, getAccountServer, setAccountServer } from '@/services/accountServer';
import { useAuthStore } from '@/store/authStore';

export function AccountServerSelector() {
  const [current, setCurrent] = useState(getAccountServer);
  const [draft, setDraft] = useState(current);
  const [error, setError] = useState('');
  const loading = useAuthStore(s => s.loading);
  function apply(value: string) {
    try { setAccountServer(value); setCurrent(getAccountServer()); setDraft(getAccountServer()); setError(''); }
    catch (err) { setError(err instanceof Error ? err.message : '地址无效'); }
  }
  return <section className="mb-5 grid gap-2 rounded-lg border border-line p-3 text-sm" aria-label="账号服务器">
    <label className="grid gap-1">账号服务器地址<input className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-ink focus:outline-none focus:ring-2 focus:ring-brand/20" type="url" value={draft} disabled={loading} onChange={e => setDraft(e.target.value)} /></label>
    <div className="flex flex-wrap gap-2"><button type="button" className="rounded-lg border border-line px-3 py-2 hover:bg-canvas disabled:opacity-50" disabled={loading} onClick={() => apply(draft)}>使用此地址</button><button type="button" className="rounded-lg border border-line px-3 py-2 hover:bg-canvas disabled:opacity-50" disabled={loading} onClick={() => apply(DEFAULT_ACCOUNT_SERVER)}>恢复默认</button></div>
    <p className="break-all">登录及账号请求将发送至：<strong>{current}</strong></p>
    {draft !== current && <p>编辑的地址尚未应用，请先点击“使用此地址”。</p>}
    <p className="text-xs text-ink-secondary">请确认这是你信任的服务器。切换地址会退出原账号；本机模型和自购 API 无需登录。</p>
    {error && <p role="alert" className="text-danger">{error}</p>}
  </section>;
}
