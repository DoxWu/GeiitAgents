import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, BookOpen, Download, Search, ShieldCheck, Trash2 } from 'lucide-react';
import { DEFAULT_PROFILE, fingerprint, LIMITS, rank, validateProfile,
  type EmbeddingProfile, type LocalIndex, type SearchHit } from '@/localKnowledge/core';
import { readLocalDocument } from '@/localKnowledge/documentImport';
import { commitIndex, loadIndex, MODEL_CACHE, SESSION_LOCK } from '@/localKnowledge/storage';
import { LocalEmbeddingClient } from '@/localKnowledge/client';
import LocalKnowledgeBackup from '@/components/workbench/LocalKnowledgeBackup';
import LocalKnowledgeAnswer from '@/components/workbench/LocalKnowledgeAnswer';
import EmbeddingProfileForm from '@/components/workbench/EmbeddingProfileForm';
import '@/styles/local-knowledge.css';

async function acquireSession(): Promise<() => void> {
  if (!navigator.locks) throw new Error('当前环境不支持本地任务锁，请使用新版桌面客户端或安全连接下的浏览器。');
  return new Promise((resolve, reject) => {
    void navigator.locks.request(SESSION_LOCK, { ifAvailable: true }, async lock => {
      if (!lock) { reject(new Error('另一个窗口正在使用本地知识库，请先在那里关闭。')); return; }
      await new Promise<void>(release => resolve(release));
    }).catch(reject);
  });
}
export default function LocalKnowledgePage() {
  const [index, setIndex] = useState<LocalIndex | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState(JSON.stringify(DEFAULT_PROFILE, null, 2));
  const [advanced, setAdvanced] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [status, setStatus] = useState('尚未启用，不会下载模型');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searched, setSearched] = useState(false);
  const [searchedQuestion, setSearchedQuestion] = useState('');
  const client = useRef<LocalEmbeddingClient | null>(null);
  const activeProfile = useRef<EmbeddingProfile>(DEFAULT_PROFILE);
  const release = useRef<(() => void) | null>(null);
  const generation = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let mounted = true;
    const lifecycle = generation;
    void loadIndex().then(value => {
      if (!mounted) return;
      setIndex(value); if (value) setDraft(JSON.stringify(value.profile, null, 2)); setLoaded(true);
    }).catch(e => { if (mounted) setError(String(e)); });
    return () => { mounted = false; lifecycle.current++; client.current?.stop(); client.current = null; release.current?.(); release.current = null; };
  }, []);
  function stop() {
    generation.current++; client.current?.stop(); client.current = null; release.current?.(); release.current = null;
    setReady(false); setBusy(false); setHits([]); setSearched(false); setStatus('已关闭本地模型；文档和已完成的缓存保留');
  }
  async function save(value: LocalIndex | null, expected: string | null) {
    setCommitting(true);
    try { await commitIndex(value, expected); setIndex(value); setHits([]); setSearched(false); }
    finally { setCommitting(false); }
  }
  async function enable() {
    const run = ++generation.current;
    setBusy(true); setError('');
    try {
      const profile = validateProfile(JSON.parse(draft));
      const unlock = await acquireSession();
      if (run !== generation.current) { unlock(); return; }
      release.current = unlock;
      const worker = new LocalEmbeddingClient(message => { if (run === generation.current) setStatus(message); });
      client.current = worker;
      setStatus('正在准备本地模型资源…');
      await worker.init(profile);
      if (run !== generation.current) return;
      // A new profile becomes active only after the entire new index commits successfully.
      if (!index || index.fingerprint !== fingerprint(profile)) {
        const rebuilt = await worker.build(index?.documents ?? [], null);
        if (run !== generation.current) return;
        await save(rebuilt, index?.revision ?? null);
      }
      activeProfile.current = profile;
      setReady(true); setStatus('本地 CPU 模型已就绪');
    } catch (e) {
      if (run !== generation.current) return;
      client.current?.stop(); client.current = null; release.current?.(); release.current = null;
      setReady(false); setError(e instanceof Error ? e.message : '模型初始化失败'); setStatus('未启用；原索引保留，可重试');
    } finally { if (run === generation.current) setBusy(false); }
  }
  async function importFiles(files: File[]) {
    if (!files.length || !client.current) return;
    const run = generation.current;
    setBusy(true); setError('');
    try {
      if (files.length + (index?.documents.length ?? 0) > LIMITS.documents) throw new Error('最多 100 个文件、合计 10 MiB 文本。');
      setStatus('读取所选文件…');
      const added = [];
      let totalBytes = index?.documents.reduce((s, d) => s + d.bytes, 0) ?? 0;
      for (const file of files) {
        if (run !== generation.current) return;
        const document = await readLocalDocument(file);
        if (run !== generation.current) return;
        totalBytes += document.bytes;
        if (totalBytes > LIMITS.totalBytes) throw new Error('提取文本合计超过 10 MiB，原索引保留。');
        added.push(document);
      }
      if (run !== generation.current) return;
      const value = await client.current!.build([...(index?.documents ?? []), ...added], index);
      if (run !== generation.current) return;
      await save(value, index?.revision ?? null);
      setStatus(`导入完成 · ${value.documents.length} 个文件 / ${value.chunks.length} 个片段`);
      // Best effort only; browser storage can still be removed by the user.
      void navigator.storage?.persist?.().catch(() => false);
    } catch (e) { if (run === generation.current) setError(e instanceof Error ? e.message : '导入失败，原索引保留'); }
    finally { if (run === generation.current) setBusy(false); }
  }
  async function search() {
    if (!client.current || !index) return;
    const run = generation.current;
    setBusy(true); setError(''); setHits([]); setSearched(false); setStatus('正在本机检索…');
    try {
      const vector = await client.current.query(query);
      if (run !== generation.current) return;
      setHits(rank(index, activeProfile.current, vector)); setSearchedQuestion(query); setSearched(true); setStatus('检索完成，片段未发送给聊天模型');
    } catch (e) { if (run === generation.current) setError(e instanceof Error ? e.message : '本地查询失败'); }
    finally { if (run === generation.current) setBusy(false); }
  }
  async function remove(documentId?: string) {
    if (!index || !window.confirm(documentId ? '删除这份本地文档和对应向量？' : '删除全部本地文档和索引？模型缓存会保留。')) return;
    setBusy(true); setError('');
    let unlock: (() => void) | undefined;
    try {
      if (!release.current) unlock = await acquireSession();
      const next = documentId ? { ...index, revision: crypto.randomUUID(), updatedAt: new Date().toISOString(),
        documents: index.documents.filter(d => d.id !== documentId), chunks: index.chunks.filter(c => c.documentId !== documentId) } : null;
      await save(next, index.revision); setStatus('本地文档已删除');
    } catch (e) { setError(e instanceof Error ? e.message : '删除失败'); }
    finally { unlock?.(); setBusy(false); }
  }
  async function clearCache() {
    if (!window.confirm('清除本地向量模型缓存？文档和索引会保留；下次启用需要重新下载。')) return;
    setBusy(true); setError('');
    let unlock: (() => void) | undefined;
    try { unlock = await acquireSession(); await caches.delete(MODEL_CACHE); setStatus('模型缓存已清除，文档与索引保留'); }
    catch (e) { setError(e instanceof Error ? e.message : '清除缓存失败'); }
    finally { unlock?.(); setBusy(false); }
  }
  return <main className="local-kb">
    <nav><Link to="/workbench"><ArrowLeft size={17} />工作台</Link><Link to="/documents">云端知识库 ↗</Link></nav>
    <header><span className="lk-eyebrow">ON YOUR DEVICE</span><h1><BookOpen />本地知识库</h1>
      <p>把你选择的文档留在本机，按内容查找相关片段。</p></header>
    <div className="lk-notice"><ShieldCheck size={21} /><div>本地文档、向量和设置独立保存，不上传到云端知识库。
      <small>存储位于此浏览器或客户端的数据目录，当前未加密，同一设备配置下的账号共享。清除应用数据会丢失本地库，请保留原文件。可在检索后选择生成模型；云端回答需要单独授权发送片段。</small></div></div>
    <div className="lk-layout"><section className="lk-card">
      <h2>1. 启用本地模型</h2><p>默认 multilingual-e5-small · 384 维 · CPU</p>
      <p className="lk-muted">首次启用下载约 129 MiB 模型资源，请预留至少 500 MiB 存储空间。加载时还需要额外内存。再次进入仍需手动启用，可复用完整缓存。</p>
      <button className="lk-text-button" disabled={ready || busy} onClick={() => setAdvanced(!advanced)}>{advanced ? '收起' : '自定义兼容 ONNX 模型'}</button>
      {advanced && <div className="lk-advanced">
        <p className="lk-muted">仅支持公开 Hugging Face 仓库，固定 commit、单文件 q8/fp32 权重、mean/cls pooling，始终 L2 归一化；最大输入 512 tokens。权重 SHA-256 必填。修改后启用会完整重建本地索引，成功前保留原版本。</p>
        <EmbeddingProfileForm draft={draft} disabled={ready || busy} onChange={setDraft} />
        <div className="lk-actions"><button disabled={ready || busy} onClick={() => setDraft(JSON.stringify(DEFAULT_PROFILE, null, 2))}>恢复默认配置</button>
          {index && <button disabled={ready || busy} onClick={() => setDraft(JSON.stringify(index.profile, null, 2))}>使用原索引配置</button>}</div></div>}
      <div className="lk-actions">
        {!ready && !busy && <button className="lk-primary" disabled={!loaded} onClick={() => void enable()}><Download size={16} />启用模型 / 按配置重建</button>}
        {(ready || busy && client.current) && <button disabled={committing} onClick={stop}>{busy ? '取消并关闭模型' : '关闭本地模型'}</button>}
        {!ready && <button disabled={busy || !loaded} onClick={() => void clearCache()}>清除模型缓存</button>}
      </div>
      <p role="status" className="lk-status">{committing ? '正在保存索引…' : status}</p>
      {error && <p role="alert" className="lk-error">{error}</p>}
    </section><section className="lk-card">
      <h2>2. 添加你的文档</h2><p className="lk-muted">Markdown / TXT：UTF-8，2 MiB；PDF：10 MB；DOCX：2 MB；PPTX：5 MB。<br />最多 100 个文件、10 MiB 提取文本、2000 个片段。PDF 不支持扫描件 OCR。</p>
      <input ref={input} type="file" accept=".md,.markdown,.txt,.pdf,.docx,.pptx" multiple hidden aria-label="选择本地文档" disabled={!ready || busy}
        onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; void importFiles(files); }} />
      <button className="lk-primary" disabled={!ready || busy} onClick={() => input.current?.click()}>选择文件并建立索引</button>
      <div className="lk-files">{!index?.documents.length && <p className="lk-empty">尚未添加文档</p>}
        {index?.documents.map(doc => <div className="lk-file" key={doc.id}><div className="lk-file-content" title={doc.name}>{doc.name}<small>{(doc.bytes / 1024).toFixed(1)} KiB 文本</small>
          {!!doc.importWarnings?.length && <details><summary>导入注意事项</summary>{doc.importWarnings.map((warning, n) => <p className="lk-muted" key={n}>{warning}</p>)}</details>}</div>
          <button aria-label={`删除 ${doc.name}`} disabled={busy} onClick={() => void remove(doc.id)}><Trash2 size={16} /></button></div>)}</div>
      {index && <div className="lk-actions"><small>{index.documents.length} 个文件 · {index.chunks.length} 个片段</small>
        <button disabled={busy} onClick={() => void remove()}>删除全部本地文档</button></div>}
    </section></div>
    <section className="lk-card lk-search"><h2>3. 查找相关内容</h2>
      <form onSubmit={e => { e.preventDefault(); void search(); }}><input aria-label="本地检索问题" placeholder="例如：报销需要准备哪些材料？" value={query} maxLength={4096} onChange={e => setQuery(e.target.value)} />
        <button className="lk-primary" disabled={!ready || busy || !index?.chunks.length || !query.trim()}><Search size={17} />本地检索</button></form>
      <p className="lk-muted">结果按向量相似度排序，相似度不是答案正确率。片段仅在本页显示。</p>
      {!hits.length && <p className="lk-empty">{searched ? '没有可检索的片段' : '启用模型并添加文档后，试着提出一个问题。'}</p>}
      {hits.map((hit, n) => <article className="lk-hit" key={`${hit.documentId}-${hit.start}`}><div><strong>{n + 1}. {hit.name}</strong><span>相似度 {hit.score.toFixed(3)}</span></div>
        <small>字符 {hit.start + 1}–{hit.end} · 入库文本（UTF-16 位置）</small><pre>{hit.text}</pre></article>)}
      {searched && hits.length > 0 && <LocalKnowledgeAnswer key={`${index?.revision}:${searchedQuestion}`} question={searchedQuestion} sources={hits} />}
    </section>
    <LocalKnowledgeBackup disabled={!loaded || ready || busy} onRestore={value => {
      setIndex(value); setDraft(JSON.stringify(value.profile, null, 2)); setHits([]); setSearched(false);
      setError(''); setStatus('本地库已恢复，模型尚未启用');
    }} />
  </main>;
}
