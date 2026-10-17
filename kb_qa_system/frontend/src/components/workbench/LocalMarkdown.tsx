import { useEffect, useRef, useState } from "react";
import { FileUp, X, FileText, Code2, Eye } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { LocalDocument } from "@/types/workbench";
import { useWorkbenchStore } from '@/store/workbenchStore';
import { ReferenceLibrary } from './ReferenceLibrary';

export const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;

export function PrivateMarkdown({ content }: { content: string }) {
  return <div className="private-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml
    components={{
      img: ({ alt }) => <span className="inline-flex items-center gap-1 text-ink-tertiary"><FileText size={14} />{alt || "图片"}</span>,
      a: ({ children }) => <span className="text-brand underline">{children}</span>,
    }}>{content}</ReactMarkdown></div>;
}

export function LocalMarkdown({ document, onChange }: { document: LocalDocument | null; onChange: (document: LocalDocument | null) => void }) {
  const unlocked = useWorkbenchStore(state => state.unlocked);
  const input = useRef<HTMLInputElement>(null);
  const readVersion = useRef(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState(false);
  useEffect(() => () => { readVersion.current++; }, []);
  async function open(file?: File) {
    if (!file) return;
    const version = ++readVersion.current;
    setError("");
    if (!/\.(md|markdown)$/i.test(file.name)) { setError("请选择 .md 或 .markdown 文件。"); setLoading(false); return; }
    if (file.size > MAX_MARKDOWN_BYTES) { setError("文件不能超过 2 MB。"); setLoading(false); return; }
    setLoading(true);
    try {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      if (version !== readVersion.current) return;
      if (content.includes("\0")) throw new Error();
      onChange({ name: file.name, content }); setSource(false);
    } catch { if (version === readVersion.current) setError("文件读取失败，请选择 UTF-8 Markdown 文档。"); }
    finally { if (version === readVersion.current) setLoading(false); }
  }
  return <section className="flex min-h-0 flex-1 flex-col" aria-label="本地 Markdown 预览"
    onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void open(event.dataTransfer.files[0]); }}>
    <div className="flex min-h-12 items-center gap-2 border-b border-line px-4">
      <FileText size={16} className="shrink-0 text-ink-secondary" />
      <span className="min-w-0 flex-1 truncate text-sm" title={document?.name}>{document?.name || "本地文档"}</span>
      <span className="text-xs text-ink-tertiary">只读 · 不上传</span>
      <button className="work-icon" title="打开 Markdown" aria-label="打开 Markdown" onClick={() => input.current?.click()}><FileUp size={17} /></button>
      {document && <><button className="work-icon" title={source ? "预览" : "源文件"} aria-label={source ? "预览" : "源文件"} onClick={() => setSource(!source)}>{source ? <Eye size={17} /> : <Code2 size={17} />}</button>
        <button className="work-icon" title="关闭文件" aria-label="关闭文件" onClick={() => { readVersion.current++; onChange(null); setLoading(false); }}><X size={17} /></button></>}
      <input ref={input} type="file" accept=".md,.markdown" className="hidden" aria-label="选择 Markdown 文件" onChange={(event) => { void open(event.target.files?.[0]); event.target.value = ""; }} />
    </div>
    {unlocked && <div className="border-b border-line px-4 py-3"><ReferenceLibrary valueName={document?.name || '粘贴材料.txt'} valueContent={document?.content || ''} maxCharacters={100000} disabled={loading || Boolean(document && document.content.length > 100000)} onLoad={(name, content) => { onChange({ name, content }); setSource(false); setError(''); }} /></div>}
    {unlocked && document && document.content.length > 100000 && <p className="px-4 py-2 text-xs text-ink-secondary">此文档超过资料库的 100000 字符上限，仍可在当前窗口只读预览。</p>}
    {error && <p role="alert" className="px-4 py-2 text-sm text-danger">{error}</p>}
    <div className="min-h-0 flex-1 overflow-auto p-5">
      {loading ? <p role="status">读取中...</p> : document ? (source ? <pre className="whitespace-pre-wrap break-words font-mono text-sm">{document.content}</pre> : <PrivateMarkdown content={document.content} />) :
        <div className="flex h-full min-h-48 flex-col items-center justify-center gap-4 text-ink-tertiary">
          <FileText size={40} strokeWidth={1} />
          <button className="work-command" onClick={() => input.current?.click()}><FileUp size={16} />打开 Markdown 文件</button>
        </div>}
    </div>
  </section>;
}
