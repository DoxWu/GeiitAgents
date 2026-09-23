export interface ChartInput {
  title: string;
  csv: string;
  categoryColumn: number;
  valueColumn: number;
  chartType: 'bar' | 'line';
  unit: string;
}
export interface ChartData { headers: string[]; rows: string[][] }
export interface CheckedChart { input: ChartInput; points: { label: string; value: number }[]; warnings: string[]; valueLabel: string }
export const CHART_RENDERER_VERSION = 'local-chart/1';

function hasControl(value: string): boolean {
  return Array.from(value).some(char => char.charCodeAt(0) < 32 && !'\r\n\t'.includes(char));
}

// Small bounded RFC-style CSV reader. Never execute spreadsheet expressions or
// guess separators, numeric locales, missing values or aggregations.
export function parseChartCsv(source: string): ChartData {
  if (!source.trim() || source.length > 100000 || hasControl(source)) throw new Error('CSV 需要非空 UTF-8 文本，最多 100000 个字符，不含控制字符。');
  const csv = source.replace(/^\uFEFF/, '');
  const records: string[][] = [];
  let row: string[] = [], field = '', quoted = false, closed = false;
  function endField() {
    if (field.length > 2000) throw new Error('CSV 单元格最多 2000 个字符。');
    row.push(field); field = ''; closed = false;
    if (row.length > 12) throw new Error('CSV 最多 12 列。');
  }
  function endRow() {
    endField(); records.push(row); row = [];
    if (records.length > 51) throw new Error('图表最多 50 条数据，请先筛选后导入。');
  }
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i];
    if (quoted) {
      if (char === '"') { if (csv[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } }
      else field += char;
    } else if (char === ',' || char === '\n' || char === '\r') {
      if (char === ',') endField();
      else { endRow(); if (char === '\r' && csv[i + 1] === '\n') i++; }
    } else if (char === '"' && !field && !closed) quoted = true;
    else {
      if (closed || char === '"') throw new Error('CSV 引号格式错误，请用双引号包裹含逗号的单元格。');
      field += char;
    }
  }
  if (quoted) throw new Error('CSV 引号未闭合。');
  if (field || row.length || closed) endRow();
  if (records.length < 2) throw new Error('CSV 至少需要表头和一条数据。');
  const headers = records[0].map(value => value.trim());
  if (headers.length < 2 || headers.some(value => !value || value.length > 60 || /[\r\n\t]/.test(value)) || new Set(headers).size !== headers.length) throw new Error('需要至少两个不重复的列名，每个列名 1–60 字符且不换行。');
  const rows = records.slice(1);
  const invalid = rows.findIndex(item => item.length !== headers.length);
  if (invalid !== -1) throw new Error(`第 ${invalid + 1} 条数据列数与表头不一致（空行也需移除）。`);
  return { headers, rows };
}

export function checkChart(input: ChartInput): CheckedChart {
  const clean = { ...input, title: input.title.trim(), unit: input.unit.trim() };
  if (!clean.title || clean.title.length > 80 || clean.unit.length > 20 || /[\r\n\t]/.test(clean.title + clean.unit) || hasControl(clean.title + clean.unit)) throw new Error('图表标题需要 1–80 字符，单位最多 20 字符，不能包含换行或控制字符。');
  if (!['bar', 'line'].includes(clean.chartType)) throw new Error('请选择柱状图或折线图。');
  const data = parseChartCsv(clean.csv);
  for (const column of [clean.categoryColumn, clean.valueColumn]) if (!Number.isInteger(column) || column < 0 || column >= data.headers.length) throw new Error('请选择有效的分类列和数值列。');
  if (clean.categoryColumn === clean.valueColumn) throw new Error('分类列和数值列不能相同。');
  const points = data.rows.map((row, index) => {
    const label = row[clean.categoryColumn].trim(), raw = row[clean.valueColumn].trim();
    if (!label || label.length > 60 || /[\r\n\t]/.test(label)) throw new Error(`第 ${index + 1} 条分类标签需要 1–60 个字符且不换行。`);
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) throw new Error(`第 ${index + 1} 条数值缺失或格式无效；仅接受小数点数字，不接受公式、百分号或千位分隔符。`);
    const value = Number(raw);
    if (!Number.isFinite(value) || Math.abs(value) > 1e12 || value !== 0 && Math.abs(value) < 1e-9 || value === 0 && /[1-9]/.test(raw.split(/[eE]/)[0])) throw new Error(`第 ${index + 1} 条数值超出支持范围（绝对值 1e-9 至 1e12，或 0）。`);
    return { label, value: Object.is(value, -0) ? 0 : value };
  });
  const warnings: string[] = [];
  if (new Set(points.map(point => point.label)).size !== points.length) warnings.push('分类标签有重复：各行独立绘制，没有自动汇总。');
  if (points.every(point => point.value === 0)) warnings.push('全部数值为 0，图形无法呈现数量差异。');
  if (points.some(point => point.value < 0)) warnings.push('存在负值，请确认业务含义；坐标轴保留零基线。');
  if (!clean.unit) warnings.push('尚未填写单位，请确认数值量纲。');
  if (clean.chartType === 'line') warnings.push('折线按输入行顺序、等间距连接；请确认顺序有意义，日期间隔不会自动换算。');
  if (points.length === 1 && clean.chartType === 'line') warnings.push('只有一个数据点，无法表达趋势。');
  const nonzero = points.map(point => Math.abs(point.value)).filter(Boolean);
  if (nonzero.length && Math.max(...nonzero) / Math.min(...nonzero) > 1000) warnings.push('数值跨度超过 1000 倍，小值可能难以看清；可查看下方完整数据。');
  return { input: clean, points, warnings, valueLabel: data.headers[clean.valueColumn] };
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
const numberText = (value: number) => value === 0 ? '0' : Math.abs(value) >= 1e6 || Math.abs(value) < 0.001 ? value.toExponential(2) : Number(value.toPrecision(5)).toString();

export function renderChartSvg(chart: CheckedChart): string {
  const { input, points, valueLabel } = chart;
  const width = Math.max(800, points.length * 74 + 160, Array.from(input.title).length * 23 + 160, (valueLabel.length + input.unit.length + 10) * 14 + 160), height = 590;
  const left = 110, right = width - 40, top = 110, bottom = 430;
  let low = Math.min(0, ...points.map(point => point.value)), high = Math.max(0, ...points.map(point => point.value));
  if (low === high) high = 1;
  const span = high - low; high += span * 0.08; if (low < 0) low -= span * 0.08;
  const y = (value: number) => bottom - (value - low) / (high - low) * (bottom - top);
  const slot = (right - left) / points.length, x = (index: number) => left + slot * (index + 0.5);
  const tag = (x: number, y: number, text: string, attrs = '') => `<text x="${x}" y="${y}" ${attrs}>${escapeXml(text)}</text>`;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="chart-title chart-description">`,
    `<title id="chart-title">${escapeXml(input.title)}</title><desc id="chart-description">${escapeXml(points.map(point => `${point.label}: ${point.value}`).join('；'))}</desc>`,
    '<rect width="100%" height="100%" fill="#ffffff"/>', '<g font-family="Microsoft YaHei, Arial, sans-serif" font-size="13" fill="#243449">',
    tag(left, 38, input.title, 'font-size="22" font-weight="bold"'), tag(left, 72, `${valueLabel}${input.unit ? `（${input.unit}）` : ''} · ${input.chartType === 'bar' ? '柱状图' : '折线图'}`)];
  for (let tick = 0; tick <= 4; tick++) {
    const value = low + (high - low) * tick / 4, yy = y(value);
    parts.push(`<line x1="${left}" x2="${right}" y1="${yy}" y2="${yy}" stroke="#e2e8f0"/>`, tag(left - 12, yy + 4, numberText(value), 'text-anchor="end"'));
  }
  parts.push(`<line x1="${left}" x2="${right}" y1="${y(0)}" y2="${y(0)}" stroke="#64748b" stroke-width="1.5"/>`);
  if (input.chartType === 'line') parts.push(`<polyline points="${points.map((point, index) => `${x(index)},${y(point.value)}`).join(' ')}" fill="none" stroke="#2563eb" stroke-width="2.5"/>`);
  points.forEach((point, index) => {
    const xx = x(index), yy = y(point.value);
    if (input.chartType === 'bar') parts.push(`<rect x="${xx - slot * .28}" y="${Math.min(yy, y(0))}" width="${slot * .56}" height="${Math.abs(yy - y(0))}" fill="${point.value < 0 ? '#b45309' : '#2563eb'}"><title>${escapeXml(`${point.label}: ${point.value}`)}</title></rect>`);
    else parts.push(`<circle cx="${xx}" cy="${yy}" r="4" fill="#2563eb"><title>${escapeXml(`${point.label}: ${point.value}`)}</title></circle>`);
    parts.push(tag(xx, point.value < 0 ? yy + 18 : yy - 10, numberText(point.value), 'text-anchor="middle" font-size="11"'));
    const label = Array.from(point.label); const clipped = label.length > 10 ? label.slice(0, 9).join('') + '…' : point.label;
    parts.push(tag(xx, bottom + 24, clipped, `text-anchor="end" transform="rotate(-40 ${xx} ${bottom + 24})"`));
  });
  parts.push(tag(left, 555, '按输入顺序绘制 · 标签和数值可能缩写，完整数据见数据表'), '</g></svg>');
  return parts.join('');
}
