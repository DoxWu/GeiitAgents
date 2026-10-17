import { useState } from 'react';
import { BookOpen, Save, Trash2 } from 'lucide-react';
import { useWorkbenchStore } from '@/store/workbenchStore';

export function ReferenceLibrary({ valueName, valueContent, maxCharacters = 100000, disabled, onLoad }: {
  valueName: string;
  valueContent: string;
  maxCharacters?: number;
  disabled?: boolean;
  onLoad: (name: string, content: string) => void;
}) {
  const store = useWorkbenchStore();
  const [selectedId, setSelectedId] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const selected = (store.referenceDocuments ?? []).find(item => item.id === selectedId);
  const options = (store.referenceDocuments ?? []).map(item => ({
    ...item,
    label: `${item.name} · ${new Date(item.updatedAt).toLocaleDateString()}`,
  }));

  async function save() {
    setError(''); setNotice('');
    try {
      const id = await store.saveReferenceDocument(valueName || '粘贴材料.txt', valueContent);
      setSelectedId(id); setNotice('材料已加密保存到本机资料库。');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存材料失败。'); }
  }
  async function remove() {
    if (!selected || !window.confirm(`从本机加密资料库删除“${selected.name}”？已创建的任务记录不受影响。`)) return;
    setError(''); setNotice('');
    try { await store.removeReferenceDocument(selected.id); setSelectedId(''); setNotice('材料已从本机资料库删除。'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '删除材料失败。'); }
  }

  return <section className="grid gap-2 border-t border-line pt-3" aria-label="本机加密参考资料库">
    <div className="flex flex-wrap items-center gap-2">
      <BookOpen size={16} aria-hidden="true" />
      <label className="work-label min-w-48 flex-1">本机资料库<select aria-label="本机资料库" className="work-input" value={selectedId} disabled={disabled || !options.length} onChange={event => setSelectedId(event.target.value)}>
        <option value="">选择已保存的材料 · {options.length}/20</option>
        {options.map(item => <option key={item.id} value={item.id} disabled={item.content.length > maxCharacters}>{item.label}{item.content.length > maxCharacters ? ' · 超过当前任务上限' : ''}</option>)}
      </select></label>
      <button type="button" className="work-command" disabled={disabled || !valueContent.trim()} onClick={() => void save()}><Save size={15} />保存当前材料</button>
      <button type="button" className="work-icon" title="载入所选材料" aria-label="载入所选材料" disabled={disabled || !selected || selected.content.length > maxCharacters} onClick={() => selected && onLoad(selected.name, selected.content)}><BookOpen size={16} /></button>
      <button type="button" className="work-icon" title="删除所选材料" aria-label="删除所选材料" disabled={disabled || !selected} onClick={() => void remove()}><Trash2 size={16} /></button>
    </div>
    <p className="text-xs text-ink-secondary">最多保存 20 份解析后的文本，随本机密钥库加密，不会自动发送；任务使用云端模型时仍需逐次授权。</p>
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    {notice && <p role="status" className="text-xs text-ink-secondary">{notice}</p>}
  </section>;
}
