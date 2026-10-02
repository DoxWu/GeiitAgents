import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { BookOpen, Plus, LockKeyhole, Settings2, FileText, MessageSquare, Send, Square, Download, Trash2, Menu, X, Loader2, ClipboardList, ImagePlus } from "lucide-react";
import { useWorkbenchStore, VAULT_STORAGE_KEY, ACCOUNT_MODEL_ID } from "@/store/workbenchStore";
import { hasStoredVault } from '@/services/privateVaultStorage';
import { useAuthStore } from "@/store/authStore";
import { LocalMarkdown, PrivateMarkdown } from "@/components/workbench/LocalMarkdown";
import { ModelConnections } from "@/components/workbench/ModelConnections";
import { OfficeTasks } from "@/components/workbench/OfficeTasks";
import { ThemeToggle } from "@/components/common/ThemeToggle";
import type { LocalDocument } from "@/types/workbench";
import { finishLabel } from '@/services/modelStream';
import { readWorkImages } from '@/services/workbenchImages';
import type { WorkImage } from '@/types/workbench';
import "@/styles/workbench.css";

const CHAT_MESSAGE_PAGE_SIZE = 20;

const PersonalItems = lazy(() => import('@/components/workbench/PersonalItems').then(module => ({ default: module.PersonalItems })));
const FileOrganizer = lazy(() => import('@/components/workbench/FileOrganizer').then(module => ({ default: module.FileOrganizer })));
const WorkbenchBackup = lazy(() => import('@/components/workbench/WorkbenchBackup').then(module => ({ default: module.WorkbenchBackup })));

export default function WorkbenchPage() {
  const state = useWorkbenchStore();
  const userId = useAuthStore((s) => s.user?.id);
  const authenticated = useAuthStore((s) => s.isAuthenticated);
  const [tab, setTab] = useState<"chat" | "tasks" | "preview" | "models" | "personal" | "files" | "backup">("chat");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [error, setError] = useState("");
  const [hasVault, setHasVault] = useState<boolean | null>(null);
  const [text, setText] = useState("");
  const [sidebar, setSidebar] = useState(false);
  const [document, setDocument] = useState<LocalDocument | null>(null);
  const [attach, setAttach] = useState(false);
  const [images, setImages] = useState<WorkImage[]>([]);
  const [allowCloudImages, setAllowCloudImages] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const previousScrollHeight = useRef<number | null>(null);
  const [visibleMessageCount, setVisibleMessageCount] = useState(CHAT_MESSAGE_PAGE_SIZE);
  const conversation = state.conversations.find((c) => c.id === state.currentId);
  const messages = conversation?.messages ?? [];
  const visibleMessages = messages.slice(-visibleMessageCount);
  const hiddenMessageCount = messages.length - visibleMessages.length;
  const running = conversation ? state.running[conversation.id] : false;
  const archive = conversation?.kind === 'knowledge-answer';
  const available = state.profiles.length > 0 || Boolean(state.accountModel);
  const selectedProfile = conversation?.profileId || (!state.profiles.length && state.accountModel ? ACCOUNT_MODEL_ID : "");
  const selectedConnection = state.profiles.find(profile => profile.id === selectedProfile);
  const cloudModel = selectedProfile === ACCOUNT_MODEL_ID || selectedConnection?.mode === 'relay';
  const conversationHasImages = messages.some(message => message.images?.length);

  useEffect(() => { void useWorkbenchStore.getState().refreshAccountModel(); }, [userId, authenticated]);

  useEffect(() => {
    let current = true;
    void hasStoredVault(VAULT_STORAGE_KEY).then(value => { if (current) setHasVault(value); })
      .catch(() => { if (current) { setHasVault(true); setError('无法访问本机加密存储，请检查浏览器存储权限。'); } });
    return () => { current = false; };
  }, [state.vaultTransferBusy, state.unlocked]);

  useEffect(() => {
    if (!state.unlocked) { setText(""); setPassword(""); setConfirmation(""); setDocument(null); setAttach(false); return; }
  }, [state.unlocked]);
  useEffect(() => { setText(""); setAttach(false); setError(""); }, [state.currentId]);
  useEffect(() => { setVisibleMessageCount(CHAT_MESSAGE_PAGE_SIZE); }, [state.currentId, conversation?.messages.length]);
  useLayoutEffect(() => {
    if (previousScrollHeight.current === null) return;
    const element = messageListRef.current;
    if (element) element.scrollTop += element.scrollHeight - previousScrollHeight.current;
    previousScrollHeight.current = null;
  }, [visibleMessageCount]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [conversation?.messages.length, running]);

  async function unlock(event: React.FormEvent) {
    event.preventDefault(); setError("");
    if (!hasVault && password !== confirmation) { setError("两次口令不一致。"); return; }
    setUnlocking(true);
    try {
      await state.unlock(password); setHasVault(true); setPassword(""); setConfirmation("");
      if (!useWorkbenchStore.getState().profiles.length && !useWorkbenchStore.getState().conversations.length && !authenticated) setTab(current => current === 'chat' ? 'models' : current);
    }
    catch (e) { setError(e instanceof Error ? e.message : "无法解锁。"); }
    finally { setUnlocking(false); }
  }
  async function send() {
    if ((!text.trim() && !images.length) || running || archive) return;
    const prompt = attach && document ? `${text.trim()}\n\n文件：${document.name}\n\n${document.content}` : text.trim();
    let id = state.currentId;
    if (!id) id = state.newConversation();
    setError("");
    try { const pending = state.send(id, prompt, images, allowCloudImages); setText(""); setAttach(false); setAllowCloudImages(false); await pending; setImages([]); }
    catch (e) {
      if (useWorkbenchStore.getState().currentId === id) {
        setError(e instanceof Error ? e.message : "发送失败。"); setText(text);
      }
    }
  }
  function download() {
    if (!conversation) return;
    const contents = `# ${conversation.title}\n\n` + conversation.messages.map((m) => `## ${m.role === "user" ? "用户" : m.model || "助手"}\n\n${m.content}${m.images?.length ? `\n\n图片附件：${m.images.map(image => image.name).join('、')}（图片数据未导出）` : ''}${m.finishReason ? '\n\n> ' + finishLabel(m.finishReason) : ''}`).join("\n\n");
    const url = URL.createObjectURL(new Blob([contents], { type: "text/markdown;charset=utf-8" }));
    const a = window.document.createElement("a"); a.href = url; a.download = `${conversation.title.replace(/[<>:"/\\|?*]/g, "_")}.md`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <div className="workbench flex h-dvh min-h-0 bg-canvas text-ink">
    {sidebar && <button className="fixed inset-0 z-30 bg-black/25 md:hidden" aria-label="关闭导航" onClick={() => setSidebar(false)} />}
    <aside className={`${sidebar ? "flex" : "hidden"} fixed inset-y-0 left-0 z-40 w-60 shrink-0 flex-col border-r border-line bg-surface md:static md:flex`}>
      <div className="flex h-16 items-center gap-3 px-4"><img src="/favicon.svg" alt="" className="h-7 w-7" /><strong className="text-base">GeiIt 工作台</strong><button className="work-icon ml-auto md:hidden" aria-label="收起导航" onClick={() => setSidebar(false)}><X size={17} /></button></div>
      <div className="px-3 pb-3"><button disabled={!state.unlocked} className="work-command w-full" onClick={() => { state.newConversation(); setImages([]); setAllowCloudImages(false); setTab("chat"); setSidebar(false); }}><Plus size={16} />新对话</button></div>
      <div className="min-h-0 flex-1 overflow-auto px-2">
        {state.conversations.map((c) => <button key={c.id} className={`flex w-full items-center gap-2 rounded px-3 py-2.5 text-left text-sm ${state.currentId === c.id ? "bg-muted font-medium" : "hover:bg-muted"}`} onClick={() => { state.select(c.id); setImages([]); setAllowCloudImages(false); setTab("chat"); setSidebar(false); }}>
          {state.running[c.id] ? <Loader2 size={15} className="shrink-0 animate-spin text-brand" /> : <MessageSquare size={15} className="shrink-0 text-ink-tertiary" />}<span className="truncate">{c.title}</span>
        </button>)}
      </div>
      <nav className="grid gap-1 border-t border-line p-3">
        <button className="work-nav" onClick={() => { setTab('personal'); setSidebar(false); }}><ClipboardList size={17} />笔记与待办</button>
        <button className="work-nav" onClick={() => { setTab('files'); setSidebar(false); }}><FileText size={17} />文件整理</button>
        <button className="work-nav" onClick={() => { setTab("preview"); setSidebar(false); }}><FileText size={17} />本地文档</button>
        <button className="work-nav" onClick={() => { setTab("models"); setSidebar(false); }}><Settings2 size={17} />模型连接</button>
        <button className="work-nav" onClick={() => { setTab('backup'); setSidebar(false); }}><Download size={17} />工作台备份</button>
        <Link className="work-nav" to="/local-knowledge"><BookOpen size={17} />本地知识库</Link>
        <Link className="work-nav" to="/documents"><BookOpen size={17} />云端知识库</Link>
        {!authenticated && <Link className="work-nav" to="/login">登录账号</Link>}
        <div className="mt-2 flex items-center justify-between border-t border-line pt-2"><ThemeToggle /><button disabled={!state.unlocked} className="work-icon" title="锁定本机密钥库" aria-label="锁定本机密钥库" onClick={() => void state.lock()}><LockKeyhole size={17} /></button></div>
      </nav>
    </aside>
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 sm:px-5">
        <button className="work-icon md:hidden" aria-label="打开导航" onClick={() => setSidebar(true)}><Menu size={18} /></button>
        <div className="flex min-w-0 flex-1 items-center gap-1" role="tablist" aria-label="工作台视图">
          {([["chat", "对话", MessageSquare], ["tasks", "任务", ClipboardList], ["preview", "文档", FileText], ["models", "模型", Settings2]] as const).map(([id, label, Icon]) => <button role="tab" aria-selected={tab === id} key={id} onClick={() => setTab(id)} className={`flex items-center gap-2 rounded px-3 py-2 text-sm ${tab === id ? "bg-muted text-ink" : "text-ink-secondary"}`}><Icon size={16} /><span>{label}</span></button>)}
        </div>
        <span className="hidden text-xs text-ink-tertiary sm:inline">{state.unlocked ? "本机密钥库已解锁" : "本机密钥库已锁定"}</span>
      </header>
      {state.storageError && <p role="alert" className="border-b border-line p-3 text-sm text-danger">{state.storageError}</p>}
      {tab === 'backup' ? <Suspense fallback={<p className="p-6">正在加载备份与恢复…</p>}><WorkbenchBackup onUnlock={() => setTab('chat')} /></Suspense> : tab === "preview" ? <LocalMarkdown document={document} onChange={(doc) => { setDocument(doc); setAttach(false); }} /> : !state.unlocked ? hasVault === null ?
        <div className="flex min-h-0 flex-1 items-center justify-center p-6"><p className="text-sm text-ink-secondary">正在检查本机密钥库…</p></div> :
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6"><form onSubmit={unlock} className="grid w-full max-w-sm gap-5">
          <LockKeyhole className="text-brand" size={28} /><h1 className="text-xl font-semibold">{hasVault ? "解锁工作台" : "创建本机密钥库"}</h1>
          <label className="work-label">解锁口令<input autoFocus className="work-input" type="password" required minLength={hasVault ? 1 : 4} autoComplete={hasVault ? "current-password" : "new-password"} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          {!hasVault && <><label className="work-label">确认口令<input className="work-input" type="password" required minLength={4} autoComplete="new-password" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} /></label><p className="text-xs text-ink-secondary">至少 4 个字符。口令不上传；遗失后无法恢复本机密钥和对话。</p></>}
          <button className="work-command justify-center bg-brand text-white" disabled={unlocking}>{unlocking ? "处理中..." : hasVault ? "解锁" : "创建"}</button>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        </form></div> : tab === "models" ? <ModelConnections /> : tab === "tasks" ? <OfficeTasks /> : tab === 'personal' ? <Suspense fallback={<p className="p-6">正在加载笔记与待办…</p>}><PersonalItems /></Suspense> : tab === 'files' ? <Suspense fallback={<p className="p-6">正在加载文件整理…</p>}><FileOrganizer /></Suspense> :
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-12 flex-wrap items-center gap-2 border-b border-line px-4 py-2">
            <select aria-label="当前对话模型" className="work-input min-w-0 flex-1 sm:max-w-80" disabled={running || archive} value={archive ? '' : selectedProfile} onChange={(e) => { setAllowCloudImages(false); if (conversation) state.setProfile(conversation.id, e.target.value); else state.newConversation(e.target.value); }}>
              <option value="">选择模型连接</option>{state.profiles.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.model}</option>)}
              {state.accountModel && <option value={ACCOUNT_MODEL_ID}>账号云端模型 · {state.accountModel.model}</option>}
              {selectedProfile === ACCOUNT_MODEL_ID && !state.accountModel && <option value={ACCOUNT_MODEL_ID} disabled>账号云端模型不可用</option>}
            </select>
            <span className="flex-1" />
            <button className="work-icon" title="导出 Markdown" aria-label="导出 Markdown" disabled={!conversation?.messages.length} onClick={download}><Download size={17} /></button>
            <button className="work-icon" title="删除对话" aria-label="删除对话" disabled={!conversation || running} onClick={() => { if (conversation && window.confirm("删除此本机对话？")) state.removeConversation(conversation.id); }}><Trash2 size={17} /></button>
          </div>
          <div ref={messageListRef} data-testid="chat-message-scroll-region" style={{ overflowAnchor: 'none' }} className="min-h-0 flex-1 overflow-auto px-4 py-6 sm:px-8">
            <div className="mx-auto max-w-3xl space-y-6">
              {!conversation?.messages.length && <div className="py-16 text-center"><MessageSquare size={32} strokeWidth={1} className="mx-auto mb-4 text-ink-tertiary" /><h1 className="text-xl font-semibold">{conversation?.title || "新对话"}</h1>
                {!state.profiles.length && <p className="mt-3 text-sm text-ink-secondary">{state.accountLoading ? "正在检查账号模型权限..." : state.accountModel ? "可直接使用账号云端模型。" : authenticated ? state.accountError || "当前账号没有可用的云端模型。" : "登录有权限的账号可使用云端模型，也可以添加自己的连接。"}</p>}
                {!available && <button className="work-command mx-auto mt-5" onClick={() => setTab("models")}><Plus size={16} />添加模型连接</button>}
                {authenticated && !state.accountModel && <button className="work-command mx-auto mt-3" disabled={state.accountLoading} onClick={() => void state.refreshAccountModel()}>刷新账号模型</button>}
              </div>}
              {hiddenMessageCount > 0 && <div className="flex items-center justify-center gap-3"><button className="work-command" onClick={() => { if (messageListRef.current) previousScrollHeight.current = messageListRef.current.scrollHeight; setVisibleMessageCount(count => count + CHAT_MESSAGE_PAGE_SIZE); }}>加载更早的消息</button><span className="text-xs text-ink-secondary">已显示 {visibleMessages.length} / {messages.length}</span></div>}
              {visibleMessages.map((message) => <article key={message.id} className="min-w-0 border-b border-line pb-5"><p className="mb-2 text-xs font-medium text-ink-secondary">{message.role === "user" ? "你" : message.model || "助手"}</p><PrivateMarkdown content={message.content} />{message.images?.length ? <div className="mt-3 flex flex-wrap gap-3">{message.images.map((image, index) => <figure key={`${message.id}-${index}`} className="max-w-52"><img className="max-h-44 max-w-52 rounded border border-line object-contain" src={image.dataUrl} alt={`用户附图 ${index + 1}`} /><figcaption className="mt-1 truncate text-xs text-ink-secondary">{image.name}</figcaption></figure>)}</div> : null}{message.finishReason && <p className="mt-3 text-xs text-ink-secondary" aria-label="模型停止原因">{finishLabel(message.finishReason)}</p>}</article>)}
              {running && state.streamingContent[conversation?.id ?? ''] && <article className="min-w-0 border-b border-line pb-5" aria-label="流式回答"><p className="mb-2 text-xs font-medium text-ink-secondary">模型输出中</p><PrivateMarkdown content={state.streamingContent[conversation?.id ?? '']} /></article>}
              {running && <p role="status" className="flex items-center gap-2 text-sm text-ink-secondary"><Loader2 size={16} className="animate-spin" />模型处理中...</p>}
              {(error || conversation && state.errors[conversation.id]) && <p role="alert" className="text-sm text-danger">{error || state.errors[conversation!.id]}</p>}
              <div ref={endRef} />
            </div>
          </div>
          {archive ? <div className="border-t border-line bg-surface p-4 text-sm text-ink-secondary">本地知识库回答 · 加密只读记录。来源是保存时的快照，不随原文件变化；此记录不能继续发送给模型。
            <button className="work-command mt-3" onClick={() => state.newConversation()}>新建对话</button></div> : <form className="border-t border-line bg-surface p-4" onSubmit={(e) => { e.preventDefault(); void send(); }}>
            <div className="mx-auto max-w-3xl">
              {document && <label className="mb-2 flex items-center gap-2 text-xs text-ink-secondary"><input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} disabled={running} /><span className="truncate">将 {document.name} 发送给所选模型</span></label>}
              {images.length > 0 && <div className="mb-3 flex flex-wrap gap-2">{images.map((image, index) => <figure key={`${image.name}-${index}`} className="relative w-20"><img className="h-16 w-20 rounded border border-line object-cover" src={image.dataUrl} alt={image.name} /><button type="button" className="work-icon absolute right-0 top-0 h-6 w-6 bg-surface" aria-label={`移除图片 ${image.name}`} title="移除图片" disabled={running} onClick={() => setImages(current => current.filter((_, itemIndex) => itemIndex !== index))}><X size={14} /></button><figcaption className="truncate text-xs text-ink-secondary">{image.name}</figcaption></figure>)}</div>}
              {cloudModel && (conversationHasImages || images.length > 0) && <label className="mb-2 flex items-start gap-2 text-xs text-ink-secondary"><input className="mt-0.5" type="checkbox" checked={allowCloudImages} onChange={event => setAllowCloudImages(event.target.checked)} disabled={running} /><span>本次将把本机图片（含此前对话中的图片）发送到云端模型。每次发送需重新授权。</span></label>}
              {(cloudModel || selectedConnection && selectedConnection.capabilities?.vision?.state !== 'supported') && (conversationHasImages || images.length > 0) && <p className="mb-2 text-xs text-ink-secondary">此模型的图片理解能力尚未验证，可能不支持图像输入。</p>}
              <div className="flex items-end gap-3"><textarea aria-label="消息" className="work-input min-h-24 resize-y" value={text} maxLength={100000} placeholder="输入任务或问题" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
                <input ref={imageInput} className="sr-only" type="file" accept="image/png,image/jpeg,image/webp" multiple aria-label="选择图片附件" onChange={async event => { try { setImages(await readWorkImages(event.currentTarget.files ?? [])); setError(''); } catch (reason) { setError(reason instanceof Error ? reason.message : '图片无法读取。'); } finally { event.currentTarget.value = ''; } }} />
                <button type="button" className="work-icon mb-1" title="附加图片" aria-label="附加图片" disabled={running} onClick={() => imageInput.current?.click()}><ImagePlus size={18} /></button>
                {running ? <button type="button" className="work-icon mb-1" title="停止" aria-label="停止" onClick={() => conversation && state.cancel(conversation.id)}><Square size={18} /></button> : <button type="submit" className="work-icon mb-1 bg-brand text-white" title="发送" aria-label="发送" disabled={(!text.trim() && !images.length) || !available || selectedProfile === ACCOUNT_MODEL_ID && !state.accountModel || cloudModel && (conversationHasImages || images.length > 0) && !allowCloudImages}><Send size={18} /></button>}
              </div>
            </div>
          </form>}
        </div>}
    </main>
  </div>;
}
