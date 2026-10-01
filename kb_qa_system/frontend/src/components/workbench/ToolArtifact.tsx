import { useEffect, useRef, useState } from 'react';
import { useWorkbenchStore } from '@/store/workbenchStore';
import type { WorkArtifact } from '@/types/workbench';
import { PrivateMarkdown } from './LocalMarkdown';
import { documentExportContent } from '@/officeTasks/document';
import { finishLabel } from '@/services/modelStream';
import { DocumentArtifact } from './DocumentArtifact';
import type { DocxStyle } from '@/officeTasks/docxStyles';
import { DocxStyleSelect } from './DocxStyleSelect';

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ToolArtifact({ artifact, versions, running }: { artifact: WorkArtifact; versions?: WorkArtifact[]; running: boolean }) {
  const [url, setUrl] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [manageVersions, setManageVersions] = useState(false);
  const [docxStyle, setDocxStyle] = useState<DocxStyle>('standard');
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (artifact.kind !== 'svg') return;
    const value = URL.createObjectURL(new Blob([artifact.content], { type: artifact.mimeType })); setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [artifact]);
  async function docx() {
    setBusy(true); setError('');
    try {
      const result = await useWorkbenchStore.getState().exportArtifactDocx(artifact.id, docxStyle);
      if (mounted.current) { download(new Blob([result.bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), result.name); setError(result.warnings.join('；')); }
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : '导出失败。'); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <section aria-label="多步骤任务成果" className="mt-4 min-w-0 border-t border-line pt-4">
    <h3 className="break-all font-medium">{artifact.name}</h3>
    {artifact.finishReason && <p className="mt-2 text-sm text-ink-secondary">{finishLabel(artifact.finishReason)}</p>}
    <div className="my-3 flex flex-wrap items-end gap-2"><button className="work-command" onClick={() => download(new Blob([artifact.kind === 'markdown' ? documentExportContent(artifact) : artifact.content], { type: artifact.mimeType }), artifact.name)}>下载成果</button>
      {artifact.kind === 'markdown' && <DocxStyleSelect value={docxStyle} onChange={setDocxStyle} disabled={busy || running} />}
      {artifact.kind === 'markdown' && <button className="work-command" disabled={busy || running} onClick={() => void docx()}>{busy ? '正在导出…' : '导出 Word'}</button>}
      {versions && artifact.kind === 'markdown' && <button className="work-command" disabled={busy || running} aria-expanded={manageVersions} onClick={() => setManageVersions(current => !current)}>{manageVersions ? '关闭版本管理' : '编辑与版本管理'}</button>}</div>
    {error && <p role="status" className="text-sm">{error}</p>}
    {manageVersions && versions && !running ? <DocumentArtifact versions={versions} /> : artifact.kind === 'markdown' ? <PrivateMarkdown content={artifact.content} /> : <div className="overflow-x-auto bg-white">{url && <img src={url} alt={artifact.name} className="max-w-none" />}</div>}
  </section>;
}
