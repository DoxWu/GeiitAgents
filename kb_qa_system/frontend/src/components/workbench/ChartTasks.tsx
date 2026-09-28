import { useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, Download, FileUp, Play, RotateCcw, Trash2 } from 'lucide-react';
import { checkChart, parseChartCsv, renderChartSvg, MAX_CHART_SERIES, type ChartInput } from '@/officeTasks/chart';
import { useWorkbenchStore } from '@/store/workbenchStore';
import type { TaskStatus } from '@/types/workbench';

const sample: ChartInput = { title: '季度销售额', csv: '月份,销售额\n一月,120\n二月,180\n三月,150', categoryColumn: 0, valueColumn: 1, chartType: 'bar', unit: '元' };
const status: Record<TaskStatus, string> = { running: '运行中', succeeded: '已完成', failed: '失败', interrupted: '已中断', cancelled: '已取消' };
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ChartImage({ svg, title }: { svg: string; title: string }) {
  const [url, setUrl] = useState('');
  useEffect(() => { const next = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })); setUrl(next); return () => URL.revokeObjectURL(next); }, [svg]);
  return <div className="mt-4 max-w-full overflow-x-auto rounded border border-line bg-white p-2">{url && <img src={url} alt={title} className="max-w-none" />}</div>;
}

export function ChartTasks() {
  const store = useWorkbenchStore();
  const [input, setInput] = useState<ChartInput>({ ...sample });
  const [checked, setChecked] = useState<ReturnType<typeof checkChart> | null>(null);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const requestId = useRef(crypto.randomUUID()), mounted = useRef(false), fileGeneration = useRef(0), fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const tasks = store.taskRuns.filter(task => task.type === 'chart.generate');
  const task = tasks.find(item => item.id === selected) ?? tasks[0];
  const artifact = store.artifacts.find(item => item.taskId === task?.id && item.kind === 'svg');
  const columns = useMemo(() => { try { return parseChartCsv(input.csv).headers; } catch { return []; } }, [input.csv]);
  const selectedValueColumns = input.valueColumns ?? [input.valueColumn];
  const savedData = useMemo(() => { try { return task?.chartInput ? checkChart(task.chartInput) : null; } catch { return null; } }, [task?.chartInput]);
  function change(patch: Partial<ChartInput>) {
    fileGeneration.current++; setInput(current => ({ ...current, ...patch })); setChecked(null); setError(''); setNotice(''); requestId.current = crypto.randomUUID();
  }
  function inspect() { setError(''); setNotice(''); try { setChecked(checkChart(input)); } catch (e) { setChecked(null); setError(e instanceof Error ? e.message : '图表数据检查失败。'); } }
  async function open(file?: File) {
    if (!file) return;
    const epoch = ++fileGeneration.current;
    try {
      if (!/\.csv$/i.test(file.name) || !file.size || file.size > 400000) throw new Error('请选择不超过 400 KB 的非空 UTF-8 CSV 文件。');
      const csv = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (!mounted.current || epoch !== fileGeneration.current) return;
      parseChartCsv(csv); change({ csv, categoryColumn: 0, valueColumn: 1, valueColumns: undefined });
    } catch (e) { if (mounted.current && epoch === fileGeneration.current) setError(e instanceof Error ? e.message : '无法读取 UTF-8 CSV。'); }
  }
  async function create() {
    if (!checked) return;
    fileGeneration.current++; setBusy(true); setError(''); setNotice('');
    const id = requestId.current;
    try {
      const taskId = await store.startChartTask(input, id);
      if (mounted.current) { setSelected(taskId); setChecked(null); setNotice('图表和检查记录已保存到本机加密库。'); }
    } catch (e) {
      if (mounted.current) {
        const failed = useWorkbenchStore.getState().taskRuns.find(item => item.id === `chart:${id}`);
        if (failed) setSelected(failed.id);
        if (!failed?.artifactIds.length) requestId.current = crypto.randomUUID();
        setError(e instanceof Error ? e.message : '图表生成失败。');
      }
    } finally { if (mounted.current) setBusy(false); }
  }
  return <section className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[240px_minmax(0,1fr)]" aria-label="图表工具">
    <aside className="max-h-48 overflow-auto border-b border-line p-3 md:max-h-none md:border-b-0 md:border-r">
      <h2 className="mb-3 text-sm font-semibold">图表任务</h2>
      {!tasks.length && <p className="text-sm text-ink-secondary">尚无图表记录</p>}
      {tasks.map(item => <button key={item.id} className={`mb-1 block w-full rounded p-2 text-left ${item.id === task?.id ? 'bg-muted' : 'hover:bg-muted'}`} onClick={() => { setSelected(item.id); setNotice(''); }}><span className="block truncate text-sm">{item.title}</span><span className="text-xs text-ink-secondary">{status[item.status]}</span></button>)}
    </aside>
    <div className="min-h-0 min-w-0 overflow-auto p-4 sm:p-6"><div className="mx-auto max-w-5xl">
      <h1 className="text-xl font-semibold">检查与生成图表</h1>
      <p className="mt-2 text-sm text-ink-secondary">本机处理 CSV，不上传或调用模型。支持 1–6 个同量纲数值系列、最多 50 条数据和 12 列。检查数据格式与表达风险，不核验业务真实性，也不识别图表图片。</p>
      <fieldset disabled={busy} className="mt-5 grid min-w-0 gap-4 border-b border-line pb-5 sm:grid-cols-2">
        <label className="work-label">图表标题<input className="work-input" maxLength={80} value={input.title} onChange={e => change({ title: e.target.value })} /></label>
        <label className="work-label">单位（可选）<input className="work-input" maxLength={20} value={input.unit} onChange={e => change({ unit: e.target.value })} /></label>
        <label className="work-label sm:col-span-2">CSV 数据<textarea aria-label="CSV 数据" className="work-input min-h-40 resize-y font-mono" maxLength={100000} value={input.csv} onChange={e => change({ csv: e.target.value })} /></label>
        <div className="flex flex-wrap gap-2 sm:col-span-2"><button className="work-command" onClick={() => fileInput.current?.click()}><FileUp size={16} />导入 CSV</button><button className="work-command" onClick={() => change({ ...sample, valueColumns: undefined })}>使用示例数据</button>
          <input ref={fileInput} hidden type="file" accept=".csv" aria-label="选择图表 CSV 文件" onChange={e => { void open(e.target.files?.[0]); e.target.value = ''; }} /></div>
        <label className="work-label">分类列<select aria-label="分类列" className="work-input" value={input.categoryColumn} onChange={e => { const categoryColumn = Number(e.target.value); const valueColumns = selectedValueColumns.filter(column => column !== categoryColumn); change({ categoryColumn, valueColumn: valueColumns[0] ?? -1, valueColumns }); }}>{columns.map((header, index) => <option key={index} value={index}>{index + 1}. {header}</option>)}</select></label>
        <fieldset className="min-w-0 rounded border border-line p-3">
          <legend className="px-1 text-sm font-medium">数值列（可多选）</legend>
          <div className="grid gap-2 sm:grid-cols-2">{columns.map((header, index) => <label key={index} className="flex min-w-0 items-start gap-2 break-all text-sm">
            <input type="checkbox" className="mt-1 shrink-0" aria-label={`数值列：${header}`} checked={selectedValueColumns.includes(index)} disabled={busy || index === input.categoryColumn || (!selectedValueColumns.includes(index) && selectedValueColumns.length >= MAX_CHART_SERIES)} onChange={event => { const valueColumns = event.target.checked ? [...selectedValueColumns, index] : selectedValueColumns.filter(column => column !== index); change({ valueColumn: valueColumns[0] ?? -1, valueColumns }); }} />{header}
          </label>)}</div>
          <p className="mt-2 text-xs text-ink-secondary">选择 1–{MAX_CHART_SERIES} 个同量纲数值列，按勾选顺序绘制。</p>
        </fieldset>
        <label className="work-label">图表类型<select aria-label="图表类型" className="work-input" value={input.chartType} onChange={e => change({ chartType: e.target.value as ChartInput['chartType'] })}><option value="bar">柱状图</option><option value="line">折线图</option></select></label>
        <div className="flex flex-wrap items-end gap-2"><button className="work-command" onClick={inspect}><BarChart3 size={16} />检查并预览</button><button className="work-command bg-brand text-white" disabled={!checked || busy} onClick={() => void create()}><Play size={16} />{busy ? '保存中…' : '保存图表任务'}</button></div>
      </fieldset>
      {error && <p role="alert" className="mt-4 text-sm text-danger">{error}</p>}{notice && <p role="status" className="mt-4 text-sm">{notice}</p>}
      {checked && <details open className="mt-5"><summary>未保存预览 · {checked.points.length} 条数据</summary><ChartImage svg={renderChartSvg(checked)} title={`预览：${checked.input.title}`} /><ChartChecks data={checked} /></details>}
      {task && <section aria-label="图表任务详情" className="mt-6 border-t border-line pt-5">
        <div className="flex flex-wrap items-center gap-2"><h2 className="min-w-0 flex-1 break-words text-lg font-semibold">{task.title}</h2>
          <button className="work-command" disabled={busy || !task.chartInput} onClick={() => task.chartInput && change({ ...task.chartInput, valueColumns: task.chartInput.valueColumns?.slice() })}><RotateCcw size={15} />复用图表输入</button>
          <button className="work-command" disabled={busy || task.status === 'running'} onClick={() => { if (window.confirm('删除此图表任务、输入和成果？')) void store.removeTask(task.id).catch(e => setError(e instanceof Error ? e.message : '删除失败。')); }}><Trash2 size={15} />删除图表任务</button></div>
        <p className="mt-2 text-sm">{status[task.status]} · {new Date(task.updatedAt).toLocaleString()}</p>{task.error && <p className="text-sm text-danger">{task.error}</p>}
        <details className="mt-3 text-xs"><summary>图表执行记录</summary>{store.toolRuns.filter(tool => tool.taskId === task.id).map(tool => <p className="mt-1" key={tool.id}>{tool.tool} · {status[tool.status]}{tool.converterVersion ? ` · ${tool.converterVersion}` : ''}</p>)}</details>
        {store.storageError && <button className="work-command mt-3" onClick={() => void store.retryStorage().catch(e => setError(e instanceof Error ? e.message : '保存失败。'))}>重试本机保存</button>}
        {artifact && <ChartDownloads key={artifact.id} svg={artifact.content} name={artifact.name} title={task.title} sha256={artifact.sha256} />}
        {savedData && <ChartChecks data={savedData} />}
      </section>}
    </div></div>
  </section>;
}

function ChartChecks({ data }: { data: ReturnType<typeof checkChart> }) {
  return <div className="mt-4 text-sm">
    <p className="font-medium">检查通过 · {data.points.length} 条数据 · {data.series.length} 个系列 · {data.warnings.length} 条提示</p>
    {data.warnings.map(warning => <p key={warning} className="mt-1 text-ink-secondary">{warning}</p>)}
    <details className="mt-3"><summary>查看完整数值</summary><div className="overflow-x-auto"><table className="mt-2 w-full"><caption className="sr-only">图表完整数据</caption><thead><tr><th className="border border-line p-2 text-left">分类</th>{data.valueLabels.map(label => <th className="border border-line p-2 text-left" key={label}>{label}{data.input.unit ? `（${data.input.unit}）` : ''}</th>)}</tr></thead><tbody>{data.points.map((point, index) => <tr key={index}><td className="break-all border border-line p-2">{point.label}</td>{data.series.map(current => <td className="border border-line p-2" key={current.label}>{current.points[index].value}</td>)}</tr>)}</tbody></table></div></details>
  </div>;
}

function ChartDownloads({ svg, name, title, sha256 }: { svg: string; name: string; title: string; sha256: string }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function png() {
    setBusy(true); setError('');
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try {
      const image = new Image(); image.src = url; await image.decode();
      if (!mounted.current || !useWorkbenchStore.getState().unlocked) return;
      const width = image.naturalWidth, height = image.naturalHeight;
      if (!width || !height || width * height > 2_500_000) throw new Error('PNG 图表尺寸超过上限，请下载 SVG。');
      const canvas = document.createElement('canvas'); canvas.width = width * 2; canvas.height = height * 2;
      const context = canvas.getContext('2d'); if (!context) throw new Error('当前设备无法创建 PNG 画布。');
      context.scale(2, 2); context.drawImage(image, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('PNG 编码失败。')), 'image/png'));
      if (mounted.current && useWorkbenchStore.getState().unlocked) download(blob, name.replace(/\.svg$/i, '.png'));
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : 'PNG 导出失败。'); }
    finally { URL.revokeObjectURL(url); if (mounted.current) setBusy(false); }
  }
  return <div className="mt-4"><p className="text-xs text-ink-secondary">成果 SHA-256 {sha256.slice(0, 12)}… · 下载文件为明文</p>
    <div className="mt-3 flex flex-wrap gap-2"><button className="work-command" onClick={() => download(new Blob([svg], { type: 'image/svg+xml' }), name)}><Download size={16} />下载 SVG</button><button className="work-command" disabled={busy} onClick={() => void png()}><Download size={16} />{busy ? '转换中…' : '下载 PNG'}</button></div>
    {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}<ChartImage svg={svg} title={`成果：${title}`} /></div>;
}
