import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, ImagePlus, Loader2, Play, RotateCcw, Trash2 } from 'lucide-react';
import { ACCOUNT_MODEL_ID, useWorkbenchStore } from '@/store/workbenchStore';
import { useAuthStore } from '@/store/authStore';
import { readWorkImages } from '@/services/workbenchImages';
import type { WorkImage } from '@/types/workbench';
import { htmlFromArtifact } from './webDesignerOutput';
import { WebPagePreview } from './WebPagePreview';

const layouts = [
  { id: 'editorial', label: '杂志纵向', description: '大标题、主视觉与章节内容' },
  { id: 'split', label: '左右分栏', description: '文字与图片并列呈现' },
  { id: 'dashboard', label: '卡片网格', description: '多列内容、数据与行动入口' },
] as const;
const effects = [
  { id: 'reveal', label: '滚动触发' }, { id: 'linked', label: '滚动联动' }, { id: 'parallax', label: '视差滚动' },
  { id: 'sticky', label: '吸顶' }, { id: 'snap', label: '滚动吸附' }, { id: 'horizontal', label: '横向滚动' },
] as const;
type EffectId = typeof effects[number]['id'];
type Colors = { primary: string; secondary: string; background: string; text: string; surface: string; button: string };
const initialColors: Colors = { primary: '#187a72', secondary: '#d59b45', background: '#f4f6f3', text: '#202b29', surface: '#ffffff', button: '#c94f39' };
function downloadHtml(content: string, filename: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/html;charset=utf-8' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Demo({ effect }: { effect: EffectId }) {
  const viewport = useRef<HTMLDivElement>(null), revealTarget = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0), [offset, setOffset] = useState(0), [revealed, setRevealed] = useState(false);
  useEffect(() => {
    setRevealed(false);
    const root = viewport.current, target = revealTarget.current;
    if (effect !== 'reveal' || !root || !target) return;
    if (!('IntersectionObserver' in window)) { setRevealed(true); return; }
    const observer = new IntersectionObserver(entries => setRevealed(entries.some(entry => entry.isIntersecting)), { root, threshold: 0.3 });
    observer.observe(target); return () => observer.disconnect();
  }, [effect]);
  function onScroll(event: React.UIEvent<HTMLDivElement>) {
    const node = event.currentTarget, distance = node.scrollHeight - node.clientHeight;
    setProgress(distance > 0 ? node.scrollTop / distance : 0);
    if (effect === 'parallax') setOffset(Math.min(40, node.scrollTop * 0.18));
  }
  return <div className="overflow-hidden border border-line" aria-label={`${effects.find(item => item.id === effect)?.label}动画示例`}>
    {effect === 'linked' && <div className="h-1 bg-muted"><div className="h-full bg-brand" style={{ width: `${Math.round(progress * 100)}%`, transition: 'width 80ms linear' }} /></div>}
    <div ref={viewport} onScroll={onScroll} className={`h-48 overflow-auto bg-surface ${effect === 'snap' ? 'scroll-smooth' : ''}`}>
      {effect === 'sticky' && <div className="sticky top-0 z-10 border-b border-line bg-surface px-3 py-2 text-xs font-medium">吸顶导航 · 滚动内容查看固定位置</div>}
      {effect === 'horizontal' ? <div className="flex h-full snap-x snap-mandatory items-center gap-3 overflow-x-auto px-4">{['01 · 概览', '02 · 方案', '03 · 成果', '04 · 联系'].map(item => <div key={item} className="flex h-32 w-48 shrink-0 snap-center items-end border border-line bg-muted p-3 text-sm">{item}</div>)}</div> :
        effect === 'snap' ? <div className="h-full snap-y snap-mandatory overflow-y-auto">{['滚动到这里吸附', '第二个内容区', '第三个内容区'].map((item, index) => <div key={item} className="flex h-full snap-start items-center justify-center border-b border-line px-4 text-sm" style={{ color: index === 1 ? '#187a72' : undefined }}>{item}</div>)}</div> :
        <div className="grid min-h-[460px] content-start gap-3 p-4">
          <div className="flex h-36 items-center justify-center border border-line bg-muted text-sm">向下滚动体验：{effects.find(item => item.id === effect)?.label}</div>
          <div ref={revealTarget} className={`flex h-28 items-center justify-center border border-line bg-muted text-sm transition-all duration-700 ${effect === 'reveal' && !revealed ? 'translate-y-6 opacity-20' : ''}`} style={effect === 'parallax' ? { transform: `translateY(${-offset}px)` } : undefined}>{effect === 'parallax' ? '内容以不同速度移动' : '动画内容进入视口'}</div>
          <div className="flex h-28 items-center justify-center border border-line text-sm">继续滚动</div>
        </div>}
    </div>
    {effect === 'linked' && <p className="border-t border-line px-3 py-2 text-xs text-ink-secondary">滚动进度 {Math.round(progress * 100)}%</p>}
  </div>;
}

export function WebDesigner() {
  const store = useWorkbenchStore(), userId = useAuthStore(state => state.isAuthenticated ? state.user?.id : undefined);
  const fileInput = useRef<HTMLInputElement>(null);
  const [layout, setLayout] = useState<(typeof layouts)[number]['id']>('editorial');
  const [colors, setColors] = useState<Colors>(initialColors);
  const [selectedEffects, setSelectedEffects] = useState<EffectId[]>(['reveal', 'sticky']);
  const [demoEffect, setDemoEffect] = useState<EffectId>('reveal');
  const [pageName, setPageName] = useState('新网页');
  const [brief, setBrief] = useState('');
  const [sampleText, setSampleText] = useState('把你希望展示的标题、介绍或按钮文案放在这里。');
  const [images, setImages] = useState<WorkImage[]>([]);
  const [profileId, setProfileId] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const tasks = store.taskRuns.filter(item => item.type === 'document.generate-markdown' && item.sourceName === 'web-design-spec.json');
  const task = tasks.find(item => item.id === selectedTaskId) ?? tasks[0];
  const artifact = task?.artifactIds.map(id => store.artifacts.find(item => item.id === id)).find(item => item?.kind === 'markdown');
  const cloud = profileId === ACCOUNT_MODEL_ID || ['relay', 'direct'].includes(store.profiles.find(item => item.id === profileId)?.mode || '');
  const imageSupport = store.profiles.find(item => item.id === profileId)?.capabilities?.vision?.state;
  const generatedHtml = useMemo(() => artifact ? htmlFromArtifact(artifact.content, task?.referenceImages ?? images) : null, [artifact, images, task?.referenceImages]);
  const palette = { '--web-primary': colors.primary, '--web-secondary': colors.secondary, '--web-background': colors.background, '--web-text': colors.text, '--web-surface': colors.surface, '--web-button': colors.button } as React.CSSProperties;
  useEffect(() => { setConsent(false); }, [profileId, userId, store.accountModel]);

  async function selectImages(files: FileList | null) {
    try { setImages(files ? await readWorkImages(files) : []); setError(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '图片无法读取。'); }
  }
  function toggleEffect(id: EffectId) {
    setSelectedEffects(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  }
  function reuseDesign() {
    if (!task?.sourceContent) return;
    try {
      const design = JSON.parse(task.sourceContent) as { layout?: string; colors?: Colors; effects?: EffectId[]; brief?: string; sampleText?: string };
      if (layouts.some(item => item.id === design.layout)) setLayout(design.layout as typeof layout);
      if (design.colors) setColors({ ...initialColors, ...design.colors });
      if (design.effects) setSelectedEffects(design.effects);
      if (design.brief) setBrief(design.brief);
      if (design.sampleText) setSampleText(design.sampleText);
      setImages(task.referenceImages ?? []); setPageName(task.title.replace(/^网页设计：/, ''));
      if (store.profiles.some(item => item.id === task.profileId) || task.profileId === ACCOUNT_MODEL_ID) setProfileId(task.profileId);
      setConsent(false); setNotice('已载入设计设置和本机加密保存的图片。');
    } catch { setError('无法读取已保存的设计设置。'); }
  }
  async function generate(event: React.FormEvent) {
    event.preventDefault(); if (busy || !profileId) return;
    setBusy(true); setError(''); setNotice(''); setConsent(false);
    const design = { layout, colors, effects: selectedEffects, brief: brief.trim(), sampleText: sampleText.trim(), images: images.map(image => ({ name: image.name, mimeType: image.mimeType })) };
    const instruction = [
      '生成一份完整、可独立运行的单文件 HTML 网页，请只输出一个 ```html 代码块。不要引用 CDN、外部字体或外部图片，不要联网。',
      '使用原生 HTML/CSS/JavaScript，响应式适配手机。实现我选择的滚动效果，并尊重 prefers-reduced-motion。脚本只使用普通 DOM 和内存状态，不访问 localStorage、sessionStorage、Cookie、parent 或 top。',
      '图片请使用精确地址 asset://image-1、asset://image-2 等占位符；应用会在本机预览和下载时嵌入附件。没有附件时不要输出占位图片。',
      '颜色、组件颜色、排版、滚动效果、图片说明和文字样例来自 source JSON，必须遵循。页面内容应体现下方需求，不要输出说明文。',
      `网页需求：${brief.trim()}`,
    ].join('\n');
    const spec = JSON.stringify(design, null, 2);
    const prior = new Set(store.taskRuns.map(item => item.id));
    const pending = store.startDocumentTask(profileId, { title: `网页设计：${pageName.trim() || '新网页'}`, instruction, outputFormat: 'html', sourceName: 'web-design-spec.json', sourceContent: spec, referenceImages: images }, consent);
    queueMicrotask(() => {
      const created = useWorkbenchStore.getState().taskRuns.find(item => !prior.has(item.id));
      if (created) setSelectedTaskId(created.id);
    });
    try { const id = await pending; setSelectedTaskId(id); setNotice('网页代码已生成并保存到本机加密任务记录。'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '网页生成失败。'); }
    finally { setBusy(false); }
  }

  return <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-6">
    <div className="mx-auto grid max-w-7xl gap-6 xl:grid-cols-[minmax(340px,0.9fr)_minmax(480px,1.1fr)]">
      <form className="grid content-start gap-5" onSubmit={generate}>
        <div><h1 className="text-xl font-semibold">AI 网页设计</h1><p className="mt-1 text-sm text-ink-secondary">调整版式、色彩、滚动效果和素材，生成可下载的独立网页。</p></div>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}{notice && <p role="status" className="text-sm text-ink-secondary">{notice}</p>}
        {!!tasks.length && <div className="flex gap-2"><label className="work-label min-w-0 flex-1">已生成网页<select aria-label="已生成网页" className="work-input" value={task?.id ?? ''} onChange={event => setSelectedTaskId(event.target.value)}>{tasks.map(item => <option key={item.id} value={item.id}>{item.title} · {item.status === 'succeeded' ? '已完成' : item.status}</option>)}</select></label><button type="button" className="work-command self-end" onClick={reuseDesign}><RotateCcw size={15} />复用设计</button></div>}
        <label className="work-label">网页名称<input className="work-input" value={pageName} maxLength={80} onChange={event => setPageName(event.target.value)} /></label>
        <label className="work-label">网页需求<textarea className="work-input min-h-24 resize-y" required maxLength={4000} value={brief} onChange={event => setBrief(event.target.value)} placeholder="例如：为一家植物工作室设计简洁的品牌首页，介绍服务并提供预约入口。" /></label>
        <fieldset className="grid gap-2"><legend className="mb-2 text-sm font-medium">页面排版</legend><div className="grid grid-cols-3 gap-2">{layouts.map(item => <button key={item.id} type="button" aria-pressed={layout === item.id} className={`grid min-h-20 content-center gap-1 border px-3 py-2 text-left text-sm ${layout === item.id ? 'border-brand bg-muted' : 'border-line'}`} onClick={() => setLayout(item.id)}><span className="font-medium">{item.label}</span><span className="text-xs text-ink-secondary">{item.description}</span></button>)}</div></fieldset>
        <fieldset className="grid gap-3"><legend className="text-sm font-medium">页面配色</legend><div className="grid grid-cols-2 gap-3">{([['primary', '主色'], ['secondary', '副色'], ['background', '页面底色'], ['text', '文字'], ['surface', '内容底色'], ['button', '按钮']] as const).map(([key, label]) => <label key={key} className="flex items-center gap-2 text-sm"><input aria-label={label} type="color" value={colors[key]} onChange={event => setColors(current => ({ ...current, [key]: event.target.value }))} className="h-9 w-11 cursor-pointer border-0 bg-transparent p-0" /><span>{label}</span><code className="ml-auto text-xs text-ink-secondary">{colors[key]}</code></label>)}</div></fieldset>
        <fieldset className="grid gap-2"><legend className="text-sm font-medium">滚动效果</legend><div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{effects.map(item => <label key={item.id} className="flex items-center gap-2 border border-line px-2 py-2 text-sm"><input type="checkbox" checked={selectedEffects.includes(item.id)} onChange={() => toggleEffect(item.id)} />{item.label}</label>)}</div><label className="work-label mt-1">动画示例<select aria-label="动画示例" className="work-input" value={demoEffect} onChange={event => setDemoEffect(event.target.value as EffectId)}>{effects.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><Demo effect={demoEffect} /></fieldset>
        <label className="work-label">示例文字<textarea className="work-input min-h-24 resize-y" maxLength={10000} value={sampleText} onChange={event => setSampleText(event.target.value)} /></label>
        <section className="grid gap-2" aria-label="网页图片素材"><div className="flex items-center justify-between"><span className="text-sm font-medium">图片素材</span><button type="button" className="work-command" disabled={busy} onClick={() => fileInput.current?.click()}><ImagePlus size={16} />添加图片</button><input ref={fileInput} hidden type="file" accept="image/png,image/jpeg,image/webp" multiple aria-label="选择网页图片" onChange={event => { void selectImages(event.currentTarget.files); event.currentTarget.value = ''; }} /></div>
          {images.length > 0 && <div className="flex flex-wrap gap-2">{images.map(image => <figure key={image.name} className="relative w-24 border border-line p-1"><img className="h-16 w-full object-cover" src={image.dataUrl} alt={image.name} /><figcaption className="truncate text-xs" title={image.name}>{image.name}</figcaption><button type="button" className="work-icon absolute right-1 top-1 bg-surface" title={`移除 ${image.name}`} aria-label={`移除 ${image.name}`} onClick={() => setImages(current => current.filter(item => item !== image))}><Trash2 size={14} /></button></figure>)}</div>}
          <p className="text-xs text-ink-secondary">最多 3 张 PNG/JPEG/WebP，每张不超过 1.5 MiB；附件仅存本机加密库，生成时随本次模型请求发送。</p>
          {images.length > 0 && imageSupport !== 'supported' && <p className="text-xs text-ink-secondary">当前连接的视觉能力尚未验证或不支持，模型可能无法理解图片内容；可在模型连接页运行视觉测试。</p>}
        </section>
        <label className="work-label">网页生成模型<select aria-label="网页生成模型" className="work-input" required value={profileId} onChange={event => { setProfileId(event.target.value); setConsent(false); }}><option value="">请选择模型</option>{store.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>)}{store.accountModel && <option value={ACCOUNT_MODEL_ID}>账号云端模型 · {store.accountModel.model}</option>}</select></label>
        {cloud && <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={consent} onChange={event => setConsent(event.target.checked)} /><span>允许本次将需求、样例文字、颜色设置和所选图片发送给云端模型；可能产生费用。</span></label>}
        {profileId && store.profiles.find(item => item.id === profileId)?.mode === 'local' && <p className="text-xs text-ink-secondary">请求发送到已配置的本机模型地址；其背后的服务是否离线取决于你的设置。</p>}
        <button type="submit" className="work-command justify-self-start bg-brand text-white" disabled={busy || !profileId || !brief.trim() || cloud && !consent}><Play size={16} />{busy ? <><Loader2 size={15} className="animate-spin" />正在生成</> : '生成网页代码'}</button>
      </form>
      <section className="grid min-w-0 content-start gap-3" aria-label="网页预览与代码">
        <div className="flex items-center gap-2 border-b border-line pb-2"><h2 className="min-w-0 flex-1 text-sm font-semibold">{generatedHtml ? '生成结果预览' : '设计预览'}</h2>{generatedHtml && <button type="button" className="work-command" onClick={() => downloadHtml(generatedHtml, `${pageName.replace(/[<>:"/\\|?*]/g, '_') || 'web-page'}.html`)}><Download size={15} />下载 HTML</button>}</div>
        {generatedHtml ? <WebPagePreview key={task?.id} html={generatedHtml} /> :
          <div style={palette} className="min-h-[520px] overflow-hidden border border-line p-5 text-[var(--web-text)] sm:p-8" data-layout={layout}>
            <header className="mb-10 flex items-center justify-between border-b border-[var(--web-primary)] pb-3" style={{ color: 'var(--web-primary)' }}><strong>{pageName || '网页名称'}</strong><span className="text-xs">介绍 · 服务 · 联系</span></header>
            <div className={layout === 'split' ? 'grid gap-8 md:grid-cols-2 md:items-center' : layout === 'dashboard' ? 'grid gap-3 sm:grid-cols-2' : 'grid gap-6'}>
              <div className="grid content-center gap-4"><p className="text-xs font-semibold uppercase" style={{ color: 'var(--web-secondary)' }}>精选介绍</p><h3 className="max-w-2xl text-3xl font-semibold">{sampleText.split('\n')[0] || '为你的内容设计一个清晰的入口'}</h3><p className="max-w-xl text-sm leading-6" style={{ color: 'var(--web-text)' }}>{sampleText}</p><button className="w-fit px-4 py-2 text-sm text-white" style={{ backgroundColor: 'var(--web-button)' }}>了解更多</button></div>
              {images[0] ? <img className="max-h-64 w-full object-cover" src={images[0].dataUrl} alt={images[0].name} /> : <div className="flex min-h-48 items-center justify-center border-2 border-dashed border-[var(--web-secondary)] text-sm" style={{ background: 'var(--web-surface)' }}>图片预览位置</div>}
              <div className="grid gap-3 sm:grid-cols-3">{['清晰结构', '品牌配色', '滚动动效'].map((item, index) => <article key={item} className="min-h-24 border border-line p-4" style={{ backgroundColor: 'var(--web-surface)', borderTop: `3px solid ${index === 1 ? 'var(--web-secondary)' : 'var(--web-primary)'}` }}><strong className="text-sm">{item}</strong><p className="mt-2 text-xs">{layouts.find(option => option.id === layout)?.description}</p></article>)}</div>
            </div>
            <footer className="mt-8 border-t border-line pt-3 text-xs" style={{ color: 'var(--web-primary)' }}>已选择 {selectedEffects.length} 种滚动效果</footer>
          </div>}
        {task?.error && <p role="alert" className="text-sm text-danger">{task.error}</p>}
        {artifact && !generatedHtml && <div className="border border-line p-3 text-sm"><p>模型已生成内容，但没有找到 HTML 代码块。</p><pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words text-xs">{artifact.content}</pre></div>}
      </section>
    </div>
  </div>;
}
