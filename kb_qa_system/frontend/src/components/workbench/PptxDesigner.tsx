import { useEffect, useRef, useState } from 'react';
import { Download, ImagePlus, Loader2, Plus, Play, Save, Trash2 } from 'lucide-react';
import { ACCOUNT_MODEL_ID, useWorkbenchStore } from '@/store/workbenchStore';
import { readWorkImages } from '@/services/workbenchImages';
import { exportDesignedPptx, validatePptxDesign, type PptxDesignDeck, type PptxDesignSlide, type PptxSlideLayout } from '@/officeTasks/pptxDesign';
import { markdownSlides } from '@/officeTasks/pptx';
import type { TaskRun, WorkImage } from '@/types/workbench';
import { ImageGenerator } from './ImageGenerator';
import { CompositionCanvas } from './CompositionCanvas';
import { newCompositionShape } from '@/officeTasks/composition';
import { applyPptxContent, pptxContentTargets } from '@/officeTasks/pptxContent';
import { useWorkbenchFence } from '@/hooks/useWorkbenchFence';
import { Hint } from './Hint';

const layouts: { id: PptxSlideLayout; label: string }[] = [
  { id: 'title', label: '标题页' }, { id: 'bullets', label: '要点列表' }, { id: 'split', label: '文字与图片' },
  { id: 'quote', label: '重点引语' }, { id: 'image', label: '图片页' },
  { id: 'custom', label: '自定义区域排版' },
];
const initialDeck = (): PptxDesignDeck => ({ title: '新建演示文稿', theme: { primary: '#187a72', secondary: '#d59b45', background: '#f4f6f3', surface: '#ffffff', text: '#202b29' }, slides: [
  { id: crypto.randomUUID(), title: '演示主题', layout: 'title', content: '', topic: '' },
  { id: crypto.randomUUID(), title: '核心内容', layout: 'bullets', content: '', topic: '' },
] });
type DesignSnapshot = Omit<PptxDesignDeck, 'slides'> & { slides: (Omit<PptxDesignSlide, 'image'> & { imageIndex?: number })[] };

function taskSnapshot(deck: PptxDesignDeck): { content: string; images: WorkImage[] } {
  const images: WorkImage[] = [];
  const slides = deck.slides.map(({ image, ...slide }) => {
    if (!image) return slide;
    const imageIndex = images.push(image) - 1;
    return { ...slide, imageIndex };
  });
  const content = JSON.stringify({ title: deck.title, theme: deck.theme, slides } satisfies DesignSnapshot);
  if (content.length > 95000) throw new Error('设计快照超过任务保存上限；请缩短各页文字后再生成。');
  return { content, images };
}

function restoreTask(task: TaskRun): PptxDesignDeck | undefined {
  if (!task.sourceContent || !task.sourceContent.startsWith('{')) return undefined;
  try {
    const snapshot = JSON.parse(task.sourceContent) as DesignSnapshot;
    const slides = snapshot.slides.map(({ imageIndex, ...slide }) => ({ ...slide, ...(imageIndex !== undefined && task.referenceImages?.[imageIndex] ? { image: task.referenceImages[imageIndex] } : {}) }));
    return validatePptxDesign({ title: snapshot.title, theme: snapshot.theme, slides });
  } catch { return undefined; }
}

function applyGeneratedContent(deck: PptxDesignDeck, content: string): PptxDesignDeck {
  const sections = markdownSlides(content, deck.title);
  if (sections.length !== deck.slides.length) throw new Error('模型返回的页数与设计不一致，原设计已保留；请调整要求后重试。');
  return { ...deck, slides: deck.slides.map((slide, index) => {
    const generated = sections[index];
    if (!generated) return slide;
    const body = generated.body.map(block => block.kind === 'table' ? block.rows.map(row => row.join(' | ')).join('\n') : block.text).join('\n');
    return { ...slide, content: slide.content.trim() && !slide.topic.trim() ? slide.content : body || slide.content };
  }) };
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function PptxDesigner() {
  const store = useWorkbenchStore(), fileInput = useRef<HTMLInputElement>(null);
  const savePptxDraft = useWorkbenchStore(state => state.savePptxDraft);
  const [deck, setDeck] = useState<PptxDesignDeck>(() => structuredClone(store.pptxDraft ?? initialDeck()));
  const mounted = useRef(false), starting = useRef(false);
  const capture = useWorkbenchFence(), latest = useRef(deck); latest.current = deck;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [selectedSlide, setSelectedSlide] = useState(deck.slides[0].id);
  const [profileId, setProfileId] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [runId, setRunId] = useState('');
  const slides = deck.slides;
  const slide = slides.find(item => item.id === selectedSlide) ?? slides[0];
  const profile = store.profiles.find(item => item.id === profileId);
  const cloud = profileId === ACCOUNT_MODEL_ID || ['relay', 'direct'].includes(profile?.mode || '');
  const runs = store.taskRuns.filter(item => item.type === 'document.generate-markdown' && ['pptx-design.json', 'pptx-layout.json'].includes(item.sourceName ?? ''));
  const run = runs.find(item => item.id === runId) ?? runs[0];

  useEffect(() => { if (!profileId) setProfileId(store.profiles[0]?.id ?? (store.accountModel ? ACCOUNT_MODEL_ID : '')); }, [profileId, store.profiles, store.accountModel]);
  useEffect(() => { setConsent(false); }, [profileId, deck]);
  useEffect(() => {
    if (!store.unlocked) return;
    const timer = setTimeout(() => { void savePptxDraft(deck).catch(reason => { if (mounted.current) setError(reason instanceof Error ? reason.message : 'PPT 设计保存失败。'); }); }, 700);
    return () => clearTimeout(timer);
  }, [deck, store.unlocked, savePptxDraft]);
  useEffect(() => {
    const savedDraft = useWorkbenchStore.getState().pptxDraft;
    const next = store.unlocked && savedDraft ? structuredClone(savedDraft) : initialDeck();
    setDeck(next); setSelectedSlide(next.slides[0].id); setNotice(''); setError('');
  }, [store.unlocked]);

  function patchDeck(patch: Partial<PptxDesignDeck>) { setDeck(current => ({ ...current, ...patch })); setError(''); }
  function patchSlide(patch: Partial<PptxDesignSlide>) { setDeck(current => ({ ...current, slides: current.slides.map(item => item.id === slide.id ? { ...item, ...patch } : item) })); setError(''); }
  function setColor(key: keyof PptxDesignDeck['theme'], value: string) { setDeck(current => ({ ...current, theme: { ...current.theme, [key]: value } })); }
  function addSlide() {
    if (slides.length >= 50) return;
    const next: PptxDesignSlide = { id: crypto.randomUUID(), title: `第 ${slides.length + 1} 页`, layout: 'bullets', content: '', topic: '' };
    setDeck(current => ({ ...current, slides: [...current.slides, next] })); setSelectedSlide(next.id);
  }
  function removeSlide() {
    if (slides.length <= 1) return;
    const next = slides.filter(item => item.id !== slide.id); setDeck(current => ({ ...current, slides: next })); setSelectedSlide(next[0].id);
  }
  function moveSlide(direction: -1 | 1) {
    const index = slides.findIndex(item => item.id === slide.id), target = index + direction;
    if (target < 0 || target >= slides.length) return;
    const next = [...slides]; [next[index], next[target]] = [next[target], next[index]]; setDeck(current => ({ ...current, slides: next }));
  }
  async function attachImage(files: FileList | null) {
    if (!files?.length) return;
    const current = capture(), original = JSON.stringify(deck);
    try {
      const [image] = await readWorkImages([files[0]]);
      const total = slides.reduce((sum, item) => sum + (item.image?.bytes ?? 0), 0) - (slide.image?.bytes ?? 0) + image.bytes;
      if (total > 4 * 1024 * 1024) throw new Error('PPT 图片附件总量不能超过 4 MiB。');
      if (!current() || JSON.stringify(latest.current) !== original) return;
      validatePptxDesign({ ...deck, slides: slides.map(item => item.id === slide.id ? { ...item, image } : item) });
      setDeck(current => ({ ...current, slides: current.slides.map(item => item.id === slide.id ? { ...item, image } : item) }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : '图片无法读取。'); }
  }
  async function generateContent(event: React.FormEvent) {
    event.preventDefault(); if (starting.current) return; starting.current = true; setBusy(true); setError(''); setNotice('');
    const current = capture(), original = JSON.stringify(deck), allowed = consent; setConsent(false);
    try {
      await store.savePptxDraft(deck);
      if (!current()) return;
      const targets = pptxContentTargets(deck);
      if (!targets.length) throw new Error('请为需要生成的页面或文字区域填写内容主题。');
      const snapshot = taskSnapshot(validatePptxDesign(deck));
      const sourceContent = JSON.stringify({ ...JSON.parse(snapshot.content), targets });
      if (sourceContent.length > 100000) throw new Error('页面与区域要求过长，请缩短主题后再生成。');
      const id = await store.startDocumentTask(profileId, { title: deck.title, instruction: '为 targets 中每个指定页面或区域撰写精炼文字。只输出一个 JSON 对象，键严格等于各 target.key，值为文字字符串。参考整份设计，保留已确定事实，不增加键，不输出代码围栏。', sourceName: 'pptx-layout.json', sourceContent, referenceImages: snapshot.images }, allowed);
      if (!current()) return;
      setRunId(id); setConsent(false);
      const completed = useWorkbenchStore.getState().taskRuns.find(item => item.id === id);
      const artifact = completed?.artifactIds.map(artifactId => useWorkbenchStore.getState().artifacts.find(item => item.id === artifactId)).find(Boolean);
      if (!artifact || completed?.status !== 'succeeded' || artifact.finishReason !== 'stop') throw new Error('模型任务没有完整完成，原设计已保留，请检查生成记录。');
      if (JSON.stringify(latest.current) !== original) throw new Error('设计已修改，生成结果保留在记录中；可从记录恢复，当前设计未覆盖。');
      const generated = applyPptxContent(deck, artifact.content);
      setDeck(generated); await store.savePptxDraft(generated);
      setNotice('页面内容已生成并填入设计稿；版式和图片设置保持不变。');
    } catch (reason) { if (current()) setError(reason instanceof Error ? reason.message : '页面内容生成失败。'); }
    finally { starting.current = false; if (mounted.current) setBusy(false); }
  }
  async function exportPptx() {
    setBusy(true); setError(''); setNotice('');
    try {
      await store.savePptxDraft(deck);
      const bytes = await exportDesignedPptx(deck);
      if (!mounted.current || !useWorkbenchStore.getState().unlocked) return;
      download(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }), `${deck.title.replace(/[<>:"/\\|?*]/g, '_') || 'presentation'}.pptx`);
      setNotice('PPTX 已在本机生成。下载后请检查页面换行、图片比例和字体替换。');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'PPTX 生成失败。'); }
    finally { setBusy(false); }
  }
  function loadRun(task: TaskRun) {
    const saved = restoreTask(task);
    if (!saved) { setError('无法读取该次生成保存的设计快照。'); return; }
    const artifact = task.artifactIds.map(id => store.artifacts.find(item => item.id === id)).find(item => item?.kind === 'markdown');
    try { setDeck(artifact?.finishReason === 'stop' ? task.sourceName === 'pptx-layout.json' ? applyPptxContent(saved, artifact.content) : applyGeneratedContent(saved, artifact.content) : saved); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '生成内容无法填入设计。'); return; }
    setSelectedSlide(saved.slides[0].id); setProfileId(task.profileId); setRunId(task.id); setConsent(false); setError('');
  }

  return <section className="grid min-h-0 flex-1 gap-5 overflow-auto p-4 lg:grid-cols-[250px_minmax(0,1fr)]" aria-label="PPT 页面设计器"><fieldset disabled={busy || !store.unlocked} className="contents">
    <aside className="grid content-start gap-3 border-b border-line pb-4 lg:border-b-0 lg:border-r lg:pr-4">
      <label className="work-label">演示文稿标题<input className="work-input" maxLength={120} value={deck.title} onChange={event => patchDeck({ title: event.target.value })} /></label>
      <div className="flex items-center justify-between"><h2 className="text-sm font-semibold">页面 · {slides.length}</h2><button className="work-icon" title="添加页面" aria-label="添加页面" disabled={slides.length >= 50} onClick={addSlide}><Plus size={17} /></button></div>
      <ol className="grid gap-1" aria-label="PPT 页面列表">{slides.map((item, index) => <li key={item.id}><button className={`w-full truncate border px-3 py-2 text-left text-sm ${item.id === slide.id ? 'border-brand bg-muted' : 'border-line'}`} onClick={() => setSelectedSlide(item.id)}>{String(index + 1).padStart(2, '0')} · {item.title || '未命名页面'}</button></li>)}</ol>
      <div className="flex gap-2"><button className="work-command" disabled={slides.length <= 1} onClick={removeSlide}><Trash2 size={15} />删除页</button><button className="work-command" disabled={slides.indexOf(slide) <= 0} onClick={() => moveSlide(-1)}>上移</button><button className="work-command" disabled={slides.indexOf(slide) >= slides.length - 1} onClick={() => moveSlide(1)}>下移</button></div>
      {runs.length > 0 && <label className="work-label">设计与生成记录<select className="work-input" value={run?.id ?? ''} onChange={event => { const selected = runs.find(item => item.id === event.target.value); if (selected) loadRun(selected); }}>
        {runs.map(item => <option key={item.id} value={item.id}>{item.title} · {item.status === 'succeeded' ? '已完成' : item.status === 'running' ? '运行中' : '未完成'}</option>)}
      </select></label>}
    </aside>
    <div className="grid content-start gap-5">
      <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-1"><h1 className="text-lg font-semibold">逐页设计 PowerPoint</h1><Hint label="逐页演示文稿设计">编辑每页布局和内容主题，或直接写入正文；支持上传或生成图片。最多50页、每页一张图片，总计8 MiB。视觉模型读取前3张图片；导出会生成可编辑的PPTX。</Hint></div><button className="work-command" onClick={() => { const next = initialDeck(); setDeck(next); setSelectedSlide(next.slides[0].id); }}>新建设计</button><button className="work-command" onClick={() => { setError(''); void store.savePptxDraft(deck).then(() => setNotice('设计已加密保存；切换页签后可继续编辑。')).catch(reason => setError(reason.message)); }}><Save size={15} />保存设计</button></div>
      <div className="grid gap-5 xl:grid-cols-[minmax(260px,0.8fr)_minmax(360px,1.2fr)]">
        <div className="grid content-start gap-4">
          <label className="work-label">本页标题<input className="work-input" maxLength={120} value={slide.title} onChange={event => patchSlide({ title: event.target.value })} /></label>
          <label className="work-label">页面版式<select aria-label="页面版式" className="work-input" value={slide.layout} onChange={event => patchSlide({ layout: event.target.value as PptxSlideLayout, ...(event.target.value === 'custom' && !slide.regions ? { regions: [{ ...newCompositionShape(0),kind:'text',color:deck.theme.text,text:slide.title,x:7,y:7,w:86,h:18 },{ ...newCompositionShape(1),kind:'text',color:deck.theme.text,text:slide.content,description:slide.topic,x:7,y:30,w:86,h:60 }] } : {}) })}>{layouts.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <label className="work-label">文字内容<textarea className="work-input min-h-36 resize-y" maxLength={12000} value={slide.content} onChange={event => patchSlide({ content: event.target.value })} placeholder="直接输入本页要展示的文字或要点，每行一项" /></label>
          <label className="work-label">内容主题<textarea className="work-input min-h-20 resize-y" maxLength={2000} value={slide.topic} onChange={event => patchSlide({ topic: event.target.value })} placeholder="可指定主题，由模型生成本页具体文字内容" /></label>
          <ImageGenerator contextKey={slide.id} disabled={busy} onImage={image => { try { validatePptxDesign({ ...deck, slides: deck.slides.map(item => item.id === slide.id ? { ...item, image } : item) }); patchSlide({ image }); } catch (reason) { setError(reason instanceof Error ? reason.message : '图片无法使用。'); } }} />
          <div className="grid gap-2"><div className="flex items-center justify-between"><span className="text-sm font-medium">本页图片</span><button type="button" className="work-command" disabled={busy || Boolean(slide.image)} onClick={() => fileInput.current?.click()}><ImagePlus size={15} />添加图片</button><input ref={fileInput} hidden type="file" accept="image/png,image/jpeg,image/webp" aria-label="选择本页图片" onChange={event => { void attachImage(event.currentTarget.files); event.currentTarget.value = ''; }} /></div>
            {slide.image ? <div className="flex items-center gap-3 border border-line p-2"><img className="h-16 w-24 object-contain" src={slide.image.dataUrl} alt={slide.image.name} /><span className="min-w-0 flex-1 truncate text-xs">{slide.image.name}</span><button className="work-icon" title="移除图片" aria-label="移除图片" onClick={() => patchSlide({ image: undefined })}><Trash2 size={15} /></button></div> : <p className="text-xs text-ink-secondary">可为每页配置一张图片；最多 50 张、总计 8 MiB。视觉读取仅发送前 3 张图片。</p>}
          </div>
        </div>
        <div className="grid content-start gap-4">
          <fieldset className="grid grid-cols-2 gap-3 border-0 p-0 sm:grid-cols-3"><legend className="mb-2 text-sm font-medium">主题颜色</legend>{([['primary', '主色'], ['secondary', '副色'], ['background', '页面底色'], ['surface', '内容底色'], ['text', '文字']] as const).map(([key, label]) => <label key={key} className="flex items-center gap-2 text-xs"><input type="color" aria-label={label} value={deck.theme[key]} onChange={event => setColor(key, event.target.value)} className="h-8 w-9 border-0 bg-transparent p-0" />{label}</label>)}</fieldset>
          {slide.layout === 'custom' ? <CompositionCanvas shapes={slide.regions ?? []} background={deck.theme.background} images={slide.image ? [slide.image] : []} onChange={regions => patchSlide({regions})} /> : <div className="min-h-[420px] border border-line p-5 sm:p-8" style={{ backgroundColor: deck.theme.background, color: deck.theme.text }}>
            <div className="mb-8 h-1 w-12" style={{ backgroundColor: deck.theme.primary }} />
            <h2 className="text-2xl font-semibold">{slide.title || '页面标题'}</h2>
            <div className={`mt-6 grid gap-5 ${slide.layout === 'split' ? 'sm:grid-cols-2' : ''}`}>
              <div className={`whitespace-pre-wrap text-sm leading-7 ${slide.layout === 'quote' ? 'text-center text-xl italic' : ''} ${slide.layout === 'image' || slide.layout === 'split' ? 'order-2 sm:order-1' : ''}`} style={{ color: slide.layout === 'quote' ? deck.theme.primary : deck.theme.text }}>{slide.content || slide.topic || '页面文字预览'}</div>
              {(slide.layout === 'image' || slide.layout === 'split') && (slide.image ? <img className="order-1 min-h-40 max-h-64 w-full object-contain sm:order-2" src={slide.image.dataUrl} alt={slide.image.name} /> : <div className="order-1 flex min-h-40 items-center justify-center border border-dashed text-sm sm:order-2" style={{ backgroundColor: deck.theme.surface, color: deck.theme.text, borderColor: deck.theme.secondary }}>图片素材预览位置</div>)}
            </div>
            <div className="mt-10 border-t pt-3 text-xs" style={{ borderColor: deck.theme.secondary, color: deck.theme.text }}>{deck.title} · {slides.findIndex(item => item.id === slide.id) + 1}</div>
          </div>}
        </div>
      </div>
      <form className="grid gap-3 border-t border-line pt-4" onSubmit={event => void generateContent(event)}>
        <label className="work-label">页面内容生成模型<select className="work-input max-w-xl" required value={profileId} onChange={event => { setProfileId(event.target.value); setConsent(false); }}><option value="">请选择模型</option>{store.profiles.map(item => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}{store.accountModel && <option value={ACCOUNT_MODEL_ID}>账号云端模型 · {store.accountModel.model}</option>}</select></label>
        {cloud && <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} /><span>允许本次发送各页标题、内容主题、已有文字和所选图片到云端模型；可能产生费用。</span></label>}
        {profile?.mode === 'local' && <p className="text-xs text-ink-secondary">请求发往已配置的本机模型地址。</p>}
        <div className="flex flex-wrap gap-2"><button className="work-command bg-brand text-white" disabled={busy || !profileId || cloud && !consent}><Play size={15} />{busy ? <><Loader2 size={15} className="animate-spin" />生成页面文字中</> : '生成页面文字'}</button><button type="button" className="work-command" disabled={busy} onClick={() => void exportPptx()}><Download size={15} />生成并下载 PPTX</button></div>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}{notice && <p role="status" className="text-sm text-ink-secondary">{notice}</p>}
        {run?.error && <p className="text-sm text-danger">最近一次模型任务：{run.error}</p>}
      </form>
    </div>
  </fieldset>{busy && <button className="work-command justify-self-start" onClick={() => { const task = store.taskRuns.find(item => ['pptx-design.json', 'pptx-layout.json'].includes(item.sourceName ?? '') && item.status === 'running'); if (task) store.cancelTask(task.id); }}>停止页面文字生成</button>}</section>;
}
