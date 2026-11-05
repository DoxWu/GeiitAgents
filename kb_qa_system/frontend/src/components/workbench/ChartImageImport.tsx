import { useEffect, useRef, useState } from 'react';
import { ImagePlus, Sparkles, X } from 'lucide-react';
import { useWorkbenchStore } from '@/store/workbenchStore';
import { useWorkbenchFence } from '@/hooks/useWorkbenchFence';
import { readWorkImages } from '@/services/workbenchImages';
import type { WorkImage } from '@/types/workbench';
import type { ChartImageDraft } from '@/officeTasks/chartFromImage';
import { Hint } from './Hint';

export function ChartImageImport({ disabled, contextKey, onDraft, onBusyChange }: {
  disabled: boolean; contextKey: string; onDraft: (draft: ChartImageDraft) => void; onBusyChange: (busy: boolean) => void;
}) {
  const store = useWorkbenchStore(), capture = useWorkbenchFence();
  const [image, setImage] = useState<WorkImage>(), [instruction, setInstruction] = useState(''), [profileId, setProfileId] = useState('');
  const [consent, setConsent] = useState(false), [loading, setLoading] = useState(false), [reading, setReading] = useState(false), [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null), controller = useRef<AbortController>(), fileVersion = useRef(0);
  const profile = store.profiles.find(item => item.id === profileId), signature = JSON.stringify(profile);
  const cloud = profile && profile.mode !== 'local';
  useEffect(() => { if (!store.profiles.some(item => item.id === profileId)) setProfileId(store.profiles[0]?.id ?? ''); }, [store.profiles, profileId]);
  useEffect(() => {
    controller.current?.abort(); setConsent(false); setError('');
  }, [contextKey, image, instruction, signature]);
  useEffect(() => { onBusyChange(loading || reading); }, [loading, reading, onBusyChange]);
  useEffect(() => () => { controller.current?.abort(); fileVersion.current++; onBusyChange(false); }, [onBusyChange]);
  useEffect(() => {
    if (!store.unlocked) { controller.current?.abort(); fileVersion.current++; setImage(undefined); setInstruction(''); setConsent(false); setError(''); setReading(false); setLoading(false); }
  }, [store.unlocked]);

  async function open(file?: File) {
    if (!file) return;
    const current = capture(), version = ++fileVersion.current;
    controller.current?.abort(); setConsent(false); setError(''); setReading(true);
    try {
      const [next] = await readWorkImages([file]);
      if (current() && version === fileVersion.current) setImage(next);
    } catch (reason) { if (current() && version === fileVersion.current) setError(reason instanceof Error ? reason.message : '图表图片读取失败。'); }
    finally { if (current() && version === fileVersion.current) setReading(false); }
  }
  async function extract() {
    if (!image || !profile || disabled || loading || reading || cloud && !consent) return;
    const current = capture(), request = new AbortController(); controller.current = request;
    setLoading(true); setError(''); setConsent(false);
    try {
      const draft = await store.extractChartImage(profile.id, image, instruction, !!cloud && consent, request.signal);
      if (current() && !request.signal.aborted) onDraft(draft);
    } catch (reason) {
      if (current() && !request.signal.aborted) setError(reason instanceof Error ? reason.message : '图表图片识别失败。');
    } finally {
      if (controller.current === request) controller.current = undefined;
      if (current()) setLoading(false);
    }
  }
  return <details className="mt-5 rounded border border-line p-4">
    <summary className="cursor-pointer font-medium">从图表图片生成</summary>
    <div className="mt-4 grid min-w-0 gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2 flex items-center gap-1 text-sm"><span>上传图表 → 模型识别 → 编辑与复核 → 保存新图表</span><Hint label="图片转图表">支持 PNG、JPEG、WebP，单图最多1.5 MiB。图片和补充要求发往所选视觉模型；云端调用可能计费。模型可能估读数值，请对照原图复核；原图不会自动存入任务。</Hint></div>
      <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
        <button className="work-command" disabled={disabled} onClick={() => fileInput.current?.click()}><ImagePlus size={16} />{reading ? '读取图片中…' : image ? '更换图表图片' : '选择图表图片'}</button>
        <input ref={fileInput} hidden type="file" accept="image/png,image/jpeg,image/webp" aria-label="选择图表图片文件" disabled={disabled} onChange={event => { void open(event.target.files?.[0]); event.target.value = ''; }} />
        {image && <><span className="min-w-0 max-w-64 truncate text-xs text-ink-secondary">{image.name}</span><button className="work-icon" disabled={disabled} aria-label="移除图表图片" onClick={() => { fileVersion.current++; setReading(false); setImage(undefined); }}><X size={16} /></button></>}
      </div>
      {image && <img src={image.dataUrl} alt="待识别的原始图表" className="max-h-64 max-w-full rounded border border-line object-contain sm:col-span-2" />}
      <label className="work-label">图片理解模型<select aria-label="图表图片理解模型" className="work-input" disabled={disabled || loading} value={profileId} onChange={event => setProfileId(event.target.value)}><option value="">请选择视觉模型</option>{store.profiles.map(item => <option key={item.id} value={item.id}>{item.name} · {item.capabilities?.vision?.state === 'supported' ? '图片已验证' : '需支持图片理解'}</option>)}</select></label>
      {!store.profiles.length && <p className="text-sm text-ink-secondary">请先在模型连接中添加视觉模型。</p>}
      <label className="work-label sm:col-span-2">补充要求（可选）<textarea className="work-input min-h-20 resize-y" maxLength={2000} disabled={disabled || loading} value={instruction} onChange={event => setInstruction(event.target.value)} placeholder="例如：提取收入与成本两组数据，改为折线图，单位保持万元。" /></label>
      {cloud && <label className="flex items-start gap-2 text-sm leading-6 sm:col-span-2"><input type="checkbox" className="mt-1" disabled={disabled || loading || reading} checked={consent} onChange={event => setConsent(event.target.checked)} />我允许本次将上传的图表图片和补充要求发送给所选云端模型</label>}
      <div className="flex flex-wrap gap-2 sm:col-span-2"><button className="work-command" disabled={disabled || loading || reading || !image || !profile || !!cloud && !consent} onClick={() => void extract()}><Sparkles size={16} />{loading ? '正在识别图表…' : '识别并生成图表草稿'}</button>{loading && <button className="work-command" onClick={() => controller.current?.abort()}>取消识别</button>}</div>
      {error && <p role="alert" className="text-sm text-danger sm:col-span-2">{error}</p>}
    </div>
  </details>;
}
