import { useRef, useState } from 'react';
import { BackupCoverage } from '@/components/common/BackupCoverage';
import { exportBackup, importBackup } from '@/localKnowledge/backup';
import { commitIndex, loadIndex, SESSION_LOCK } from '@/localKnowledge/storage';
import type { LocalIndex } from '@/localKnowledge/core';

interface Props { disabled: boolean; onRestore: (index: LocalIndex) => void }
export default function LocalKnowledgeBackup({ disabled, onRestore }: Props) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ index: LocalIndex; expected: string | null } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);
  async function locked<T>(action: () => Promise<T>): Promise<T> {
    if (!navigator.locks) throw new Error('当前环境不支持本地任务锁。');
    return navigator.locks.request(SESSION_LOCK, { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('请先关闭所有窗口的本地模型和其他备份任务。');
      return action();
    });
  }
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(''); setMessage('');
    try { await action(); }
    catch (e) { setError(e instanceof Error ? e.message : '备份操作失败，原知识库未更改。'); }
    finally { setBusy(false); setPassword(''); setConfirmation(''); }
  }
  async function download() {
    setPreview(null);
    await run(async () => {
      if (password !== confirmation) throw new Error('两次备份口令不一致。');
      const blob = await locked(async () => {
        const current = await loadIndex();
        if (!current) throw new Error('当前没有可导出的本地知识库。');
        return exportBackup(current, password);
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = `geiit-local-${new Date().toISOString().replace(/[:.]/g, '-')}.geiitkb`;
      anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
      setMessage('已生成加密备份并发起下载，请确认文件已保存。');
    });
  }
  async function previewFile(file: File) {
    const token = ++sequence.current;
    setPreview(null);
    await run(async () => {
      const result = await locked(async () => {
        const current = await loadIndex();
        return { index: await importBackup(file, password), expected: current?.revision ?? null };
      });
      if (token !== sequence.current) return;
      setPreview(result); setMessage('备份解密与结构校验通过，尚未写入本地知识库。');
    });
  }
  async function restore() {
    if (!preview) return;
    const target = preview;
    await run(async () => {
      await locked(() => commitIndex(target.index, target.expected));
      onRestore(target.index); setPreview(null);
      setMessage('本地知识库已恢复。模型保持关闭，需手动启用；模型缓存单独管理。');
    });
  }
  return <section className="lk-card lk-search" aria-label="本地知识库备份与恢复">
    <h2>4. 备份与恢复</h2>
    <BackupCoverage />
    <p className="lk-muted">导出包含本地文档、向量和模型设置的加密文件，不包含模型权重、聊天记录或 API Key。备份口令不保存，遗失后无法恢复。请先关闭本地模型。</p>
    <fieldset disabled={disabled || busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
      <div className="lk-backup-fields"><label>备份口令<input type="password" autoComplete="new-password" minLength={4} maxLength={256} value={password} onChange={e => setPassword(e.target.value)} /></label>
        <label>确认备份口令（仅导出）<input type="password" autoComplete="new-password" maxLength={256} value={confirmation} onChange={e => setConfirmation(e.target.value)} /></label></div>
      <div className="lk-actions"><button onClick={() => void download()} disabled={password.length < 4 || password !== confirmation}>导出加密备份</button>
        <button onClick={() => input.current?.click()} disabled={password.length < 4}>选择备份并预检查</button></div>
      <input ref={input} type="file" hidden accept=".geiitkb" aria-label="选择知识库备份" onChange={e => {
        const file = e.target.files?.[0]; e.target.value = ''; if (file) void previewFile(file);
      }} />
      {preview && <div className="lk-hit"><strong>待恢复：{preview.index.documents.length} 个文件 · {preview.index.chunks.length} 个片段</strong>
        <p className="lk-muted">模型：{preview.index.profile.repo}。恢复将整体替换当前本地库；需要保留现有内容时，请先取消并导出当前库。</p>
        <div className="lk-actions"><button className="lk-primary" onClick={() => void restore()}>确认替换本地库</button>
          <button onClick={() => { sequence.current++; setPreview(null); setError(''); setMessage('已取消恢复，当前库未更改。'); }}>取消恢复</button></div></div>}
    </fieldset>
    {busy && <p role="status">正在处理加密备份…</p>}
    {message && <p role="status">{message}</p>}
    {error && <p role="alert" className="lk-error">{error}</p>}
  </section>;
}
