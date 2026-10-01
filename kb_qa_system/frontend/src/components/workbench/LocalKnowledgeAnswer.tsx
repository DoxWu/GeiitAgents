import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ACCOUNT_MODEL_ID, useWorkbenchStore } from '@/store/workbenchStore';
import type { SearchHit } from '@/localKnowledge/core';
import { createAnswerArtifact, downloadAnswer, type KnowledgeAnswerArtifact, type KnowledgeAnswerTurn } from '@/localKnowledge/answerArtifact';
import type { KnowledgeTurn } from '@/localKnowledge/answer';
import type { GenerationPreview as Preview } from '@/services/generationPreview';
import { finishLabel } from '@/services/modelStream';
import { GenerationPreview } from './GenerationPreview';

export default function LocalKnowledgeAnswer({ question, sources }: { question: string; sources: SearchHit[] }) {
  const store = useWorkbenchStore();
  const [selected, setSelected] = useState(sources.map((_, i) => i));
  const [profileId, setProfileId] = useState('');
  const [consent, setConsent] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [answer, setAnswer] = useState<KnowledgeAnswerArtifact | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState('');
  const [followUp, setFollowUp] = useState('');
  const savingRef = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const profile = store.profiles.find(p => p.id === profileId);
  const cloud = profileId === ACCOUNT_MODEL_ID || profile?.mode === 'relay';
  const endpoint = profile?.baseUrl ?? (profileId === ACCOUNT_MODEL_ID ? '账号所配置的服务端模型供应商' : '尚未选择');
  const signature = JSON.stringify([profileId, profile, store.accountModel]);
  const sourceSignature = JSON.stringify([question, sources.map(({ documentId, name, start, end, text }) => ({ documentId, name, start, end, text }))]);
  useEffect(() => {
    const previous = controller.current; controller.current = null; previous?.abort();
    setConsent(false); setAnswer(null); setPreview(null); setError(''); setBusy(false); setFollowUp('');
  }, [signature, store.unlocked, sourceSignature]);
  useEffect(() => { setSelected(sources.map((_, i) => i)); }, [sources]);
  useEffect(() => () => { const previous = controller.current; controller.current = null; previous?.abort(); }, []);
  function resetSelection(next: number[]) { setSelected(next); setConsent(false); setAnswer(null); setFollowUp(''); }
  async function generate(nextQuestion = question, continuing = false) {
    if (controller.current || savingRef.current) return;
    const request = new AbortController(); controller.current = request;
    setBusy(true); setError(''); if (!continuing) setAnswer(null); setPreview(null);
    // Consent is per request and is never persisted or reused automatically.
    const allowed = consent; setConsent(false);
    const chosen = selected.map(i => ({ ...sources[i] }));
    const archiveHistory: KnowledgeAnswerTurn[] = continuing && answer ? [...(answer.history ?? []), {
      question: answer.question, content: answer.content, model: answer.model, ...(answer.finishReason ? { finishReason: answer.finishReason } : {}),
    }] : [];
    const history: KnowledgeTurn[] = archiveHistory.map(turn => ({ question: turn.question, answer: turn.content }));
    try {
      const onPreview = (value: Preview | null) => {
        if (controller.current === request && !request.signal.aborted) setPreview(value);
      };
      const result = continuing
        ? await store.answerKnowledge(profileId, nextQuestion, chosen, allowed, request.signal, onPreview, history)
        : await store.answerKnowledge(profileId, nextQuestion, chosen, allowed, request.signal, onPreview);
      if (!request.signal.aborted && controller.current === request) {
        setAnswer(createAnswerArtifact(nextQuestion, result, chosen, archiveHistory));
        setFollowUp('');
      }
    } catch (e) {
      if (controller.current === request) setError(request.signal.aborted ? '回答请求已停止。' : e instanceof Error ? e.message : '回答生成失败。');
    } finally { if (controller.current === request) { controller.current = null; setBusy(false); setPreview(null); } }
  }
  async function unlock() {
    setError('');
    try { await store.unlock(password); }
    catch { setError('密钥库解锁失败，请检查口令。'); }
    finally { setPassword(''); }
  }
  async function saveAnswer() {
    if (!answer || savingRef.current) return;
    savingRef.current = true; setSaving(true); setError('');
    try { setSavedId(await store.saveKnowledgeAnswer(answer)); }
    catch (e) { setError(e instanceof Error ? e.message : '回答保存失败，请重试或导出。'); }
    finally { savingRef.current = false; setSaving(false); }
  }
  const saved = !!answer && savedId === `knowledge-answer:${answer.id}`;
  return <section className="lk-hit" aria-label="根据本地来源生成回答">
    <h2>使用这些来源生成回答</h2>
    <p>问题：{question}</p>
    <p className="lk-muted">生成模型与本地向量模型独立。仅发送下方勾选的片段、文件名、当前问题和本线程的前序问答，不发送整个知识库。回答仅在本页显示，不自动保存到对话。</p>
    {!store.unlocked ? <div className="lk-backup-fields"><label>密钥库解锁口令<input type="password" value={password} maxLength={256} onChange={e => setPassword(e.target.value)} /></label>
      <button disabled={password.length < 4} onClick={() => void unlock()}>解锁生成模型</button><Link to="/workbench">前往工作台创建密钥库/配置模型</Link></div> : <>
      <fieldset disabled={busy || saving} style={{ border: 0, padding: 0, minWidth: 0 }}>
        <label>回答生成模型<select aria-label="回答生成模型" value={profileId} onChange={e => setProfileId(e.target.value)}>
          <option value="">请选择模型</option>
          {store.profiles.map(p => <option key={p.id} value={p.id}>{p.name} · {p.mode === 'local' ? '本机接口' : '云端转发'} · {p.model}</option>)}
          {store.accountModel && <option value={ACCOUNT_MODEL_ID}>账号云端模型 · {store.accountModel.model}</option>}
        </select></label>
        <div className="lk-actions"><button disabled={store.accountLoading} onClick={() => void store.refreshAccountModel()}>检查账号云端模型权限</button><Link to="/workbench">管理模型连接</Link></div>
        {store.accountError && <p className="lk-muted">{store.accountError}</p>}
        <p className="lk-muted">目标：{endpoint}</p>
        {sources.map((source, i) => <label className="lk-source-choice" key={`${source.documentId}:${source.start}`}>
          <input type="checkbox" checked={selected.includes(i)} onChange={e => resetSelection(e.target.checked ? [...selected, i].sort((a, b) => a - b) : selected.filter(n => n !== i))} />
          来源 {i + 1}：{source.name}（字符 {source.start + 1}–{source.end}）</label>)}
        {cloud && <label className="lk-source-choice"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />
          我允许本次将所选本地片段、文件名、问题和本线程前序问答，经应用服务端发送给上述云端模型</label>}
        {profile?.mode === 'local' && <p className="lk-muted">请求发往上述本机接口；接口背后的模型是否完全离线取决于你自己的服务配置。</p>}
        <button className="lk-primary" disabled={!profileId || !selected.length || !!cloud && !consent} onClick={() => void generate()}>根据所选来源生成回答</button>
      </fieldset>
      {busy && <div className="lk-actions"><span role="status">正在生成回答…</span><button onClick={() => { setPreview(null); controller.current?.abort(); }}>停止生成</button></div>}
      {busy && preview && <GenerationPreview value={preview} label="本地知识库回答生成中的预览" />}
    </>}
    {error && <p role="alert" className="lk-error">{error}</p>}
    {answer && <article className="lk-answer"><h3>回答 · {answer.model}</h3><pre>{answer.content}</pre>
      {answer.finishReason && <p className="lk-muted" aria-label="回答生成状态">{finishLabel(answer.finishReason)}</p>}
      <p className="lk-muted">导出文件含问题、回答和来源原文，文件本身不加密。保存到工作台后为本机加密的独立只读记录，不会再次发送给模型。</p>
      {answer.history?.map((turn, index) => <details key={index}><summary>第 {index + 1} 轮 · {turn.question}</summary><pre>{turn.content}</pre><p className="lk-muted">{turn.model}{turn.finishReason ? ` · ${finishLabel(turn.finishReason)}` : ''}</p></details>)}
      <p>当前问题：{answer.question}</p>
      <div className="lk-actions"><button disabled={busy || saving} onClick={() => {
        try { downloadAnswer(answer); } catch { setError('导出失败，请检查下载设置后重试。'); }
      }}>导出回答 Markdown</button>
        <button disabled={busy || saving || saved || !store.unlocked} onClick={() => void saveAnswer()}>{saving ? '正在加密保存…' : saved ? '已保存到工作台' : '保存为独立对话记录'}</button>
        {saved && <Link to="/workbench" onClick={() => store.select(savedId)}>打开已保存记录</Link>}</div>
      <div className="lk-backup-fields"><label>继续追问（仍使用当前来源快照）<textarea aria-label="本地知识库追问" disabled={busy || saving || !store.unlocked} value={followUp} maxLength={4096} onChange={e => setFollowUp(e.target.value)} placeholder="例如：请比较来源中的两个方案。" /></label>
        <p className="lk-muted">每轮追问会发送所选来源和全部前序问答；云端追问请先勾选上方的本次授权。最多保留 9 轮问答，达到上限可重新生成。</p>
        <button disabled={busy || saving || !store.unlocked || (answer.history?.length ?? 0) >= 8 || !followUp.trim() || !profileId || !!cloud && !consent} onClick={() => void generate(followUp.trim(), true)}>发送追问</button>
      </div>
      <p className="lk-muted">模型回答需核对原文，来源编号对应本次发送的片段：</p>
      {answer.sources.map((source, i) => <details key={i}><summary>[{i + 1}] {source.name} · 字符 {source.start + 1}–{source.end}</summary><pre>{source.text}</pre></details>)}
    </article>}
  </section>;
}
