import { useEffect, useRef, useState } from 'react';
import { BackupCoverage } from '@/components/common/BackupCoverage';
import { useWorkbenchStore } from '@/store/workbenchStore';
import { MAX_VAULT_BACKUP_BYTES, type VaultBackupSummary } from '@/services/vaultBackup';

const fields: [keyof VaultBackupSummary, string][] = [['profiles', '模型连接'], ['apiKeys', '模型 API Key'], ['conversations', '对话'], ['messages', '消息'], ['tasks', '办公任务'], ['artifacts', '文档与图表成果'], ['personalItems', '笔记与待办'], ['personalDrafts', '笔记/待办草稿'], ['reminderDrafts', '邮件提醒草稿'], ['reminderTemplates', '提醒模板'], ['organizerRuns', '文件整理记录'], ['fileEditVersions', '文本版本'], ['fileEditDrafts', '文本编辑草稿']];
function Summary({ summary }: { summary: VaultBackupSummary }) {
  return <div className="space-y-3"><p className="text-sm">备份时间：{new Date(summary.exportedAt).toLocaleString()} · 工作流定义 {summary.workflows} 个</p><dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">{fields.map(([key, label]) => <div className="rounded border border-line p-2" key={key}><dt className="text-ink-secondary">{label}</dt><dd className="mt-1 font-medium">{summary[key]}</dd></div>)}</dl></div>;
}
export function WorkbenchBackup({ onUnlock }: { onUnlock: () => void }) {
  const store = useWorkbenchStore();
  const [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState(''), [includeKeys, setIncludeKeys] = useState(false);
  const [file, setFile] = useState<File | null>(null), [backupPassword, setBackupPassword] = useState(''), [localPassword, setLocalPassword] = useState(''), [localConfirmation, setLocalConfirmation] = useState('');
  const [acknowledged, setAcknowledged] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [exported, setExported] = useState<VaultBackupSummary | null>(null);
  const mounted = useRef(false), operation = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; useWorkbenchStore.getState().cancelVaultTransfer(); }; }, []);
  useEffect(() => { setPassword(''); setConfirmation(''); setBackupPassword(''); setLocalPassword(''); setLocalConfirmation(''); setAcknowledged(false); setExported(null); }, [store.unlocked]);
  function invalidate() { store.cancelVaultTransfer(); setAcknowledged(false); setError(''); setNotice(''); }
  async function run(action: () => Promise<void>) {
    if (store.vaultTransferBusy) return;
    const token = ++operation.current; setError(''); setNotice('');
    try { await action(); }
    catch (e) { if (mounted.current && token === operation.current) setError(e instanceof Error ? e.message : '备份或恢复失败。'); }
    finally { if (mounted.current && token === operation.current) { setPassword(''); setConfirmation(''); setBackupPassword(''); setLocalPassword(''); setLocalConfirmation(''); } }
  }
  const busy = store.vaultTransferBusy;
  return <section className="min-h-0 flex-1 overflow-auto p-4 sm:p-6" aria-label="工作台备份与恢复"><div className="mx-auto max-w-3xl space-y-6">
    <div><h1 className="text-xl font-semibold">工作台备份与恢复</h1><p className="mt-3 text-sm text-ink-secondary">备份在本机加密后下载，不上传服务器。包含对话、办公成果、笔记/待办、持久草稿与文件操作历史；本地知识库文档/向量请使用其独立备份入口。模型权重、云端数据、登录凭据、未保存的页面输入和外部目录文件不在此备份中。</p></div>
    <BackupCoverage />
    <section className="space-y-3 rounded border border-line p-4" aria-label="导出工作台备份"><h2 className="font-semibold">导出加密备份</h2>
      {store.unlocked ? <form className="space-y-3" onSubmit={e => { e.preventDefault(); void run(async () => {
        if (password !== confirmation) throw new Error('两次备份口令不一致。');
        const result = await store.exportWorkbenchBackup(password, includeKeys);
        if (!mounted.current || !useWorkbenchStore.getState().unlocked) return;
        const url = URL.createObjectURL(result.file), link = document.createElement('a'); link.href = url; link.download = `GeiIt-工作台-${result.summary.exportedAt.slice(0, 10)}.geiitwork`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        setExported(result.summary); setNotice('加密备份已生成并发起下载，请确认文件已保存。');
      }); }}><fieldset disabled={busy} className="space-y-3">
        <label className="work-label">备份口令<input className="work-input" type="password" minLength={4} maxLength={256} required autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
        <label className="work-label">确认备份口令<input className="work-input" type="password" minLength={4} maxLength={256} required autoComplete="new-password" value={confirmation} onChange={e => setConfirmation(e.target.value)} /></label>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={includeKeys} onChange={e => setIncludeKeys(e.target.checked)} />在加密备份中包含模型 API Key</label>
        <p className="text-xs text-ink-secondary">默认不导出 API Key，恢复后需要重新填写。备份口令至少 4 个字符，建议使用较长口令；遗失后无法解密。仅包含点击导出时的快照，之后的修改需再次备份。</p>
        <button className="work-command bg-brand text-white" type="submit">下载加密工作台备份</button>
      </fieldset></form> : <div className="space-y-2"><p className="text-sm">导出前需要解锁本机工作台。</p><button className="work-command" disabled={busy} onClick={onUnlock}>前往解锁工作台</button></div>}
      {exported && <Summary summary={exported} />}
    </section>
    <section className="space-y-3 rounded border border-line p-4" aria-label="恢复工作台备份"><h2 className="font-semibold">从备份恢复</h2>
      <p className="text-sm text-ink-secondary">恢复会整体替换当前本机工作台，不合并。建议先导出当前工作台。恢复后保持锁定，任务不会自动继续，目录权限不会恢复；服务端邮件提醒仍由服务器独立管理。</p>
      {store.unlocked ? <button className="work-command" disabled={busy || store.organizerBusy} onClick={() => void store.lock()}>锁定工作台以准备恢复</button> : <form className="space-y-3" onSubmit={e => { e.preventDefault(); void run(async () => {
        if (!file) throw new Error('请选择工作台备份文件。'); if (localPassword !== localConfirmation) throw new Error('两次新解锁口令不一致。');
        await store.prepareWorkbenchRestore(file, backupPassword, localPassword);
      }); }}><fieldset disabled={busy} className="space-y-3">
        <label className="work-label">工作台备份文件<input className="work-input" type="file" accept=".geiitwork,application/json" onChange={e => { invalidate(); const selected = e.target.files?.[0] ?? null; setFile(null); if (selected && (!selected.size || selected.size > MAX_VAULT_BACKUP_BYTES)) setError('备份文件为空或超过 24 MiB。'); else setFile(selected); }} /></label>
        <label className="work-label">此备份的口令<input className="work-input" type="password" minLength={4} maxLength={256} required autoComplete="off" value={backupPassword} onChange={e => { invalidate(); setBackupPassword(e.target.value); }} /></label>
        <label className="work-label">恢复后的新解锁口令<input className="work-input" type="password" minLength={4} maxLength={256} required autoComplete="new-password" value={localPassword} onChange={e => { invalidate(); setLocalPassword(e.target.value); }} /></label>
        <label className="work-label">确认新解锁口令<input className="work-input" type="password" minLength={4} maxLength={256} required autoComplete="new-password" value={localConfirmation} onChange={e => { invalidate(); setLocalConfirmation(e.target.value); }} /></label>
        <button className="work-command" type="submit" disabled={!file || store.organizerBusy}>解密并预检查备份</button>
      </fieldset></form>}
      {store.vaultRestorePreview && <section className="space-y-3 border-t border-line pt-4" aria-label="工作台恢复预览"><h3 className="font-medium">恢复预览</h3><Summary summary={store.vaultRestorePreview.summary} />
        <p className="text-sm">{store.vaultRestorePreview.replacing ? '本机已有密钥库，确认后将替换其中全部工作台数据。' : '本机尚无密钥库，将从备份创建。'}{store.vaultRestorePreview.summary.apiKeys ? '此备份包含模型 API Key；恢复后仅在主动使用相应连接时调用。' : '此备份不包含模型 API Key。'}</p>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={acknowledged} disabled={busy} onChange={e => setAcknowledged(e.target.checked)} />我已核对备份内容并确认整体恢复到本机工作台</label>
        <button className="work-command bg-brand text-white" disabled={busy || !acknowledged} onClick={() => { const id = store.vaultRestorePreview!.id; void run(async () => { await store.commitWorkbenchRestore(id); if (mounted.current) { setNotice('恢复已完成。请使用刚设置的新解锁口令打开工作台。'); setFile(null); setAcknowledged(false); } }); }}>确认恢复工作台</button>
      </section>}
    </section>
    {(busy || store.vaultRestorePreview) && <button className="work-command" onClick={() => { operation.current++; invalidate(); setPassword(''); setConfirmation(''); setBackupPassword(''); setLocalPassword(''); setLocalConfirmation(''); }}>取消备份或恢复预检查</button>}
    {busy && <p role="status" className="text-sm">正在本机加密或校验，请稍候…</p>}
    {error && <p role="alert" className="break-words text-sm text-danger">{error}</p>}{notice && <p role="status" className="text-sm">{notice}</p>}
    {!store.unlocked && <button className="work-command" disabled={busy} onClick={onUnlock}>返回工作台解锁</button>}
  </div></section>;
}
