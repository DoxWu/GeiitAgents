import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Save, PlugZap, Trash2, Pencil, X } from 'lucide-react';
import { useWorkbenchStore } from '@/store/workbenchStore';
import { useAuthStore } from '@/store/authStore';
import type { ModelCapabilityEvidence, ModelProfile } from '@/types/workbench';
import type { ModelCatalog } from '@/services/modelDiscovery';

type Draft = Omit<ModelProfile, 'hasKey' | 'textTestedAt' | 'toolTestedAt' | 'capabilities'>;
const empty = (): Draft => ({ id: crypto.randomUUID(), name: '', mode: 'relay', baseUrl: '', model: '' });

function capabilityLabel(evidence: ModelCapabilityEvidence | undefined, legacyTestedAt?: string): string {
  if (evidence?.state === 'unsupported') return evidence.testedAt ? `不支持（${new Date(evidence.testedAt).toLocaleString()}）` : '不支持';
  if (evidence?.state === 'supported' && evidence.testedAt) return `最近测试通过（${new Date(evidence.testedAt).toLocaleString()}）`;
  return legacyTestedAt ? `最近测试通过（${new Date(legacyTestedAt).toLocaleString()}）` : '未验证';
}

function unknownCapability(evidence: ModelCapabilityEvidence | undefined): string {
  if (evidence?.state === 'supported') return evidence.value ? `已探测（${evidence.value.toLocaleString()}）` : '已探测支持';
  if (evidence?.state === 'unsupported') return '已探测不支持';
  return '未知（未探测）';
}

export function ModelConnections() {
  const profiles = useWorkbenchStore(s => s.profiles);
  const accountModel = useWorkbenchStore(s => s.accountModel);
  const accountLoading = useWorkbenchStore(s => s.accountLoading);
  const accountError = useWorkbenchStore(s => s.accountError);
  const userId = useAuthStore(s => s.isAuthenticated ? s.user?.id : undefined);
  const [draft, setDraft] = useState(empty);
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [operation, setOperation] = useState<'save' | 'test' | 'tool-test' | 'list' | null>(null);
  const [message, setMessage] = useState('');
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const active = useRef<AbortController | null>(null);
  const busy = operation === 'save' || operation === 'test' || operation === 'tool-test';
  const existing = profiles.find(p => p.id === draft.id);
  const dirty = Boolean(apiKey || clearKey || !existing || (['name', 'baseUrl', 'model', 'mode', 'maxTokens'] as const).some(key => draft[key] !== existing[key]));

  const invalidate = useCallback(() => {
    active.current?.abort(); active.current = null;
    setOperation(null); setCatalog(null); setMessage('');
  }, []);
  useEffect(() => {
    invalidate(); setApiKey(''); setClearKey(false);
    return () => { active.current?.abort(); active.current = null; };
  }, [userId, invalidate]);

  function reset(config: Draft = empty()) { invalidate(); setDraft(config); setApiKey(''); setClearKey(false); }
  function editConnection(change: Partial<Draft>) { invalidate(); setDraft({ ...draft, ...change }); }
  async function action(kind: 'save' | 'test' | 'tool-test' | 'list', callback: (signal: AbortSignal) => Promise<() => void>) {
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    setOperation(kind); setMessage('');
    if (kind === 'list') setCatalog(null);
    try {
      const apply = await callback(controller.signal);
      if (active.current === controller && !controller.signal.aborted) apply();
    } catch (error) {
      if (active.current === controller && !controller.signal.aborted) setMessage(error instanceof Error ? error.message : '操作失败。');
    } finally {
      if (active.current === controller) { active.current = null; setOperation(null); }
    }
  }

  return <div className="mx-auto w-full max-w-3xl overflow-auto p-5 sm:p-8">
    <div className="mb-5 flex items-center justify-between"><h2 className="text-lg font-semibold">模型连接</h2><button className="work-icon" title="新建连接" aria-label="新建连接" onClick={() => reset()} disabled={busy}><Plus size={18} /></button></div>
    <section aria-label="账号云端模型" className="mb-5 grid gap-2 rounded-lg border border-line p-3 text-sm">
      <h3 className="font-medium">账号云端模型</h3>
      <p className="break-words">{accountModel && accountModel.userId === userId ? '已授权：' + accountModel.model : userId ? accountError || '当前账号没有可用的云端模型。' : '登录有权限的账号后，可使用账号云端模型。'}</p>
      <p className="text-xs text-ink-secondary">仅显示账号获准使用的配置；由服务端管理。个人连接失败时不会自动切换。</p>
      {userId && <button type="button" className="work-command justify-self-start" disabled={accountLoading} onClick={() => void useWorkbenchStore.getState().refreshAccountModel()}>{accountLoading ? '正在检查权限…' : '刷新账号模型'}</button>}
    </section>
    <div className="mb-6 divide-y divide-line border-y border-line">
      {profiles.map(profile => <div key={profile.id} className="flex items-center gap-3 py-3">
        <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{profile.name}</p><p className="truncate text-xs text-ink-secondary">{profile.model} · {profile.mode === 'local' ? '本机直连' : '云端临时转发'}</p></div>
        <button className="work-icon" title="编辑连接" aria-label={'编辑 ' + profile.name} disabled={busy} onClick={() => { const { hasKey: _, textTestedAt: __, toolTestedAt: ___, capabilities: ____, ...config } = profile; reset(config); }}><Pencil size={16} /></button>
        <button className="work-icon" title="删除连接" aria-label={'删除 ' + profile.name} disabled={busy} onClick={() => { if (window.confirm('删除模型连接“' + profile.name + '”？')) void action('save', async () => { await useWorkbenchStore.getState().removeProfile(profile.id); return () => { reset(); setMessage('连接已删除。'); }; }); }}><Trash2 size={16} /></button>
      </div>)}
      {!profiles.length && <p className="py-4 text-sm text-ink-tertiary">暂无模型连接</p>}
    </div>
    <form className="grid gap-4" onSubmit={event => { event.preventDefault(); void action('save', async () => {
      await useWorkbenchStore.getState().saveProfile(draft, apiKey, clearKey);
      return () => {
        const saved = useWorkbenchStore.getState().profiles.find(p => p.id === draft.id);
        if (saved) { const { hasKey: _, textTestedAt: __, toolTestedAt: ___, capabilities: ____, ...config } = saved; setDraft(config); }
        setApiKey(''); setClearKey(false); setMessage('连接已加密保存到本机。');
      };
    }); }}>
      <fieldset disabled={busy} className="grid min-w-0 gap-4">
        <label className="work-label">连接名称<input className="work-input" required maxLength={100} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
        <label className="work-label">调用方式<select aria-label="调用方式" className="work-input" value={draft.mode} onChange={e => editConnection({ mode: e.target.value as ModelProfile['mode'], baseUrl: e.target.value === 'local' ? 'http://127.0.0.1:11434/v1' : '', model: '' })}>
          <option value="relay">云端临时转发</option><option value="local">本机直连（Ollama / LM Studio）</option>
        </select></label>
        <label className="work-label">API Base URL<input className="work-input" type="url" required maxLength={2048} placeholder={draft.mode === 'local' ? 'http://127.0.0.1:11434/v1' : 'https://api.example.com/v1'} value={draft.baseUrl} onChange={e => editConnection({ baseUrl: e.target.value })} /></label>
        <label className="work-label">API Key<input className="work-input" type="password" autoComplete="new-password" maxLength={4096} placeholder={existing?.hasKey ? '已保存；留空保持原密钥' : draft.mode === 'local' ? '可选' : '必填'} value={apiKey} onChange={e => { invalidate(); setApiKey(e.target.value); }} /></label>
        {existing?.hasKey && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={clearKey} onChange={e => { invalidate(); setClearKey(e.target.checked); }} />清除已保存密钥</label>}
        <div className="grid min-w-0 gap-2">
          <button className="work-command justify-self-start" type="button" disabled={operation === 'list'} onClick={() => void action('list', async signal => {
            const result = await useWorkbenchStore.getState().discoverProfileModels(draft, apiKey, clearKey, signal);
            return () => { setCatalog(result); setMessage(result.models.length ? '已获取 ' + result.models.length + ' 个模型。' : '列表为空，可继续手填模型名称。'); };
          })}>{operation === 'list' ? '正在获取模型…' : '获取模型列表'}</button>
          <p className="text-xs text-ink-secondary">主动读取当前接口的模型列表，不会自动下载或切换模型。列表不可用时仍可手填。</p>
          {catalog && <>
            {catalog.models.length > 0 && <label className="work-label">从列表选择模型<select className="work-input min-w-0 max-w-full" value="" onChange={e => { if (e.target.value) setDraft({ ...draft, model: e.target.value }); }}>
              <option value="">选择后填入模型名称</option>{catalog.models.map(model => <option key={model.id} value={model.id}>{model.id}</option>)}
            </select></label>}
            {catalog.truncated && <p className="text-xs text-ink-secondary">仅展示部分有效模型（最多 500 个）；未列出的模型也可手填。</p>}
          </>}
        </div>
        <label className="work-label">模型名称<input className="work-input" required maxLength={200} placeholder="模型服务中的完整模型名称，也可手填" value={draft.model} onChange={e => setDraft({ ...draft, model: e.target.value })} /></label>
        <label className="work-label">最大输出 Token（可选）<input className="work-input" type="number" min={1} max={2147483647} placeholder="模型默认" value={draft.maxTokens ?? ''} onChange={e => setDraft({ ...draft, maxTokens: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>
      </fieldset>
      <div className="rounded-lg border border-line p-3 text-xs text-ink-secondary">
        <p>文本调用：{!dirty ? capabilityLabel(existing?.capabilities?.text, existing?.textTestedAt) : '未验证'}</p>
        <p>工具调用：{!dirty ? capabilityLabel(existing?.capabilities?.toolCalls, existing?.toolTestedAt) : '未验证'}</p>
        <p>图片输入：{!dirty ? unknownCapability(existing?.capabilities?.vision) : '未知（配置已修改）'}；上下文长度：{!dirty ? unknownCapability(existing?.capabilities?.contextWindow) : '未知（配置已修改）'}；最大输出上限：{draft.maxTokens ? `${draft.maxTokens.toLocaleString()}（服务商支持性未知）` : '未配置（服务商上限未知）'}。</p>
        <p>保存后可测试文本调用，会发送一条短消息，服务商可能计费。</p>
        <p>工具调用测试会要求模型返回固定的 `inspect_csv` 空参数调用；不执行工具或发送文件，但服务商可能计费。</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button className="work-command bg-brand text-white" type="submit" disabled={Boolean(operation)}><Save size={16} />{operation === 'save' ? '处理中...' : '保存连接'}</button>
        <button className="work-command" type="button" disabled={Boolean(operation) || dirty} onClick={() => void action('test', async signal => { await useWorkbenchStore.getState().testProfile(draft.id, signal); return () => { setMessage('模型文本调用成功，验证时间已加密保存。'); }; })}><PlugZap size={16} />测试连接</button>
        <button className="work-command" type="button" disabled={Boolean(operation) || dirty} onClick={() => void action('tool-test', async signal => { await useWorkbenchStore.getState().testProfileToolSupport(draft.id, signal); return () => { setMessage('模型已按 inspect_csv 契约返回工具调用，验证时间已加密保存。'); }; })}><PlugZap size={16} />测试工具调用</button>
        {(operation === 'list' || operation === 'test' || operation === 'tool-test') && <button className="work-command" type="button" onClick={() => { invalidate(); setMessage('请求已取消。'); }}>取消请求</button>}
        <button className="work-icon" type="button" aria-label="清空表单" title="清空表单" disabled={busy} onClick={() => reset()}><X size={16} /></button>
      </div>
      {message && <p role="status" className="text-sm break-words">{message}</p>}
    </form>
  </div>;
}
