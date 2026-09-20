import { validateProfile, type EmbeddingProfile } from '@/localKnowledge/core';

export default function EmbeddingProfileForm({ draft, disabled, onChange }: {
  draft: string; disabled: boolean; onChange: (value: string) => void;
}) {
  let fields: Record<string, unknown> | null = null;
  let error = '';
  try {
    const value: unknown = JSON.parse(draft);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置必须是 JSON 对象。');
    fields = value as Record<string, unknown>;
    validateProfile(fields as unknown as EmbeddingProfile);
  } catch (e) { error = e instanceof Error ? e.message : '配置格式无效。'; }
  function update(key: string, value: string | number) {
    onChange(JSON.stringify({ ...fields, [key]: value, normalize: true }, null, 2));
  }
  return <fieldset disabled={disabled} className="lk-profile-form">
    <p className="lk-muted">只影响本地向量检索。编辑不会下载模型；点击启用后才检查资源并按需重建索引。始终使用 L2 归一化。</p>
    {fields && <div className="lk-profile-grid">
      {([
        ['repo', 'Hugging Face 仓库', '例如 Xenova/multilingual-e5-small'],
        ['revision', '固定版本 commit', '仓库的完整 40 位 commit，不接受 main'],
        ['sha256', 'ONNX 权重 SHA-256', '对应所选精度权重文件的完整 64 位摘要'],
        ['queryPrefix', '检索问题前缀', 'E5 使用 query: 加一个空格；保留末尾空格'],
        ['passagePrefix', '文档片段前缀', 'E5 使用 passage: 加一个空格；保留末尾空格'],
      ] as const).map(([key, label, hint]) => <label key={key}>{label}<input value={typeof fields![key] === 'string' ? fields![key] as string : ''}
        spellCheck={false} onChange={e => update(key, e.target.value)} /><small>{hint}</small></label>)}
      <label>权重精度<select value={String(fields.dtype ?? '')} onChange={e => update('dtype', e.target.value)}><option value="q8">INT8 / q8</option><option value="fp32">FP32</option></select></label>
      <label>Pooling<select value={String(fields.pooling ?? '')} onChange={e => update('pooling', e.target.value)}><option value="mean">mean</option><option value="cls">cls</option></select></label>
      <label>向量维度<input type="number" min={1} max={2048} step={1} value={typeof fields.dimensions === 'number' ? fields.dimensions : ''} onChange={e => update('dimensions', Number(e.target.value))} /></label>
      <label>最大输入 Token<input type="number" min={16} max={512} step={1} value={typeof fields.maxTokens === 'number' ? fields.maxTokens : ''} onChange={e => update('maxTokens', Number(e.target.value))} /><small>向量模型输入上限，与聊天模型的可选输出 Token 无关。</small></label>
    </div>}
    {error && <p role="alert" className="lk-error">配置尚未有效：{error}</p>}
    <details><summary>高级 JSON 配置</summary><label htmlFor="lk-profile">本地向量模型配置（JSON）</label>
      <textarea id="lk-profile" value={draft} spellCheck={false} onChange={e => onChange(e.target.value)} /></details>
  </fieldset>;
}
