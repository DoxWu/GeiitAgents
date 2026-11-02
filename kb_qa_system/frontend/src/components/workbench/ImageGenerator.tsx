import { useEffect, useRef, useState } from 'react';
import { useWorkbenchStore } from '@/store/workbenchStore';
import type { WorkImage } from '@/types/workbench';
import { generateServerImage, listServerImageModels, type ServerImageModel } from '@/api/serverImages';
import { useAuthStore } from '@/store/authStore';
import { useWorkbenchFence } from '@/hooks/useWorkbenchFence';
import { DEFAULT_IMAGE_SIZE, type ImageSize } from '@/services/imageGeneration';

export function ImageGenerator({ onImage, disabled = false, contextKey, requestPrompt, size = DEFAULT_IMAGE_SIZE, referenceImages = [] }: { onImage: (image: WorkImage) => void; disabled?: boolean; contextKey: string; requestPrompt?: string; size?: ImageSize; referenceImages?: WorkImage[] }) {
  const profiles = useWorkbenchStore(state => state.profiles), unlocked = useWorkbenchStore(state => state.unlocked);
  const candidates = profiles.filter(item => item.imageModel);
  const userId = useAuthStore(state => state.user?.id), capture = useWorkbenchFence();
  const candidateCount = candidates.length;
  const [profileId, setProfileId] = useState(''), [localPrompt, setPrompt] = useState(''), [consent, setConsent] = useState(false);
  const prompt = requestPrompt ?? localPrompt;
  const [serverModels, setServerModels] = useState<ServerImageModel[]>([]), [serverModelId, setServerModelId] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const active = useRef<AbortController | null>(null);
  const chosen = candidates.find(item => item.id === profileId) ?? candidates[0];
  const signature = JSON.stringify([chosen, serverModelId, contextKey, unlocked, userId, requestPrompt, size.width, size.height, disabled, referenceImages]);
  useEffect(() => { if (!unlocked) setPrompt(''); }, [unlocked]);
  useEffect(() => {
    let active = true; const current = capture(); setServerModels([]);
    if (unlocked) void listServerImageModels().then(models => { if (active && current()) { setServerModels(models); setServerModelId(current => models.some(item => item.id === current) ? current : models[0]?.id ?? ''); if (!candidateCount && models.length) setProfileId(current => current.startsWith('server:') ? current : `server:${models[0].id}`); } }).catch(() => { if (active && current()) setServerModels([]); });
    return () => { active = false; };
  }, [candidateCount, unlocked, userId, capture]);
  useEffect(() => { active.current?.abort(); active.current = null; setBusy(false); setConsent(false); setError(''); return () => { active.current?.abort(); }; }, [signature]);
  async function generate() {
    const useServer = profileId.startsWith('server:');
    if ((!chosen && !useServer) || active.current) return;
    const current = capture(), controller = new AbortController(); active.current = controller;
    setBusy(true); setError(''); const allowed = consent; setConsent(false);
    try {
      const image = useServer
        ? await generateServerImage(serverModelId, prompt, allowed, controller.signal, size, referenceImages)
        : await useWorkbenchStore.getState().generateImage(chosen!.id, prompt, allowed, controller.signal, size, referenceImages);
      if (!controller.signal.aborted && current()) onImage(image);
    }
    catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '生图失败。'); }
    finally { if (active.current === controller) { active.current = null; setBusy(false); } }
  }
  return <details className="min-w-0 border border-line p-3"><summary className="cursor-pointer text-sm font-medium">由模型生成图片</summary><div className="mt-3 grid min-w-0 gap-3">
    {!candidates.length && !serverModels.length ? <p className="text-xs text-ink-secondary">请在模型连接中配置本机生图模型，或由部署者配置服务端生图环境变量。</p> : <>
      <label className="work-label">生图连接<select className="work-input" value={profileId.startsWith('server:') ? profileId : chosen?.id ?? ''} disabled={busy || disabled} onChange={event => { const value = event.target.value; setProfileId(value); if (value.startsWith('server:')) setServerModelId(value.slice('server:'.length)); setConsent(false); }}>{candidates.map(item => <option key={item.id} value={item.id}>{item.name} · {item.imageModel}（本机连接）</option>)}{serverModels.map(item => <option key={`server:${item.id}`} value={`server:${item.id}`}>{item.model}（服务端）</option>)}</select></label>
      {requestPrompt === undefined ? <label className="work-label">图片内容主题<textarea className="work-input min-h-20 resize-y" maxLength={1000} value={prompt} disabled={busy || disabled} onChange={event => { setPrompt(event.target.value); setConsent(false); }} placeholder="描述图片主体、风格、构图与色调" /></label> : <p className="text-xs text-ink-secondary">使用上方图片提示词和当前构图，输出 {size.width} × {size.height} 像素；修改构图后需要重新授权。</p>}
      <p className="text-xs text-ink-secondary">{referenceImages.length ? `本次将直接发送${referenceImages.length}张参考原图及提示词给生图模型，请使用支持图片编辑的模型。参考图按上传顺序编号为图1、图2。` : '本次使用文字生图。上传参考图片后将使用图片编辑接口。'}</p>
      {(profileId.startsWith('server:') || chosen?.mode !== 'local') && <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={consent} disabled={busy || disabled} onChange={event => setConsent(event.target.checked)} />允许本次将上述描述{referenceImages.length ? `和${referenceImages.length}张参考原图` : ''}发送到所选云端生图模型，可能产生费用</label>}
      <div className="flex gap-2"><button type="button" className="work-command" disabled={!unlocked || busy || disabled || !prompt.trim() || (!profileId.startsWith('server:') && chosen?.mode !== 'local' && !consent) || profileId.startsWith('server:') && !consent} onClick={() => void generate()}>{busy ? '正在生成图片…' : '生成图片并放入设计'}</button>{busy && <button type="button" className="work-command" onClick={() => { active.current?.abort(); active.current = null; setBusy(false); }}>取消生图</button>}</div>
    </>}{error && <p role="alert" className="text-xs text-danger">{error}</p>}
  </div></details>;
}
