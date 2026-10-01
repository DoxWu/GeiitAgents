export interface ChartInput {
  title: string;
  csv: string;
  categoryColumn: number;
  valueColumn: number;
  /** Optional multi-series selection. valueColumn remains the legacy first series. */
  valueColumns?: number[];
  chartType: 'bar' | 'horizontal_bar' | 'line' | 'pie' | 'scatter';
  unit: string;
}
export interface ChartData { headers: string[]; rows: string[][] }
export interface ChartSeries { label: string; points: { label: string; value: number }[] }
export interface CheckedChart {
  input: ChartInput;
  points: { label: string; value: number }[];
  series: ChartSeries[];
  xValues: number[];
  warnings: string[];
  categoryLabel: string;
  valueLabel: string;
  valueLabels: string[];
}
export const CHART_RENDERER_VERSION = 'local-chart/5';
export const MAX_CHART_SERIES = 6;

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
  const clean: ChartInput = { ...input, title: input.title.trim(), unit: input.unit.trim() };
  if (!clean.title || clean.title.length > 80 || clean.unit.length > 20 || /[\r\n\t]/.test(clean.title + clean.unit) || hasControl(clean.title + clean.unit)) throw new Error('图表标题需要 1–80 字符，单位最多 20 字符，不能包含换行或控制字符。');
  if (!['bar', 'horizontal_bar', 'line', 'pie', 'scatter'].includes(clean.chartType)) throw new Error('请选择有效的图表类型。');
  const data = parseChartCsv(clean.csv);
  const requestedColumns = clean.valueColumns === undefined ? [clean.valueColumn] : clean.valueColumns;
  if (!Array.isArray(requestedColumns) || requestedColumns.length < 1 || requestedColumns.length > MAX_CHART_SERIES) throw new Error(`请选择 1–${MAX_CHART_SERIES} 个数值系列。`);
  const valueColumns = [...requestedColumns];
  if (new Set(valueColumns).size !== valueColumns.length) throw new Error('数值列不能重复选择。');
  if (valueColumns.some(column => !Number.isInteger(column) || column < 0 || column >= data.headers.length)) throw new Error('请选择有效的分类列和数值列。');
  if (valueColumns.includes(clean.categoryColumn)) throw new Error('分类列和数值列不能相同。');
  clean.valueColumn = valueColumns[0];
  clean.valueColumns = valueColumns;
  if (clean.chartType === 'pie' && valueColumns.length !== 1) throw new Error('饼图只能选择一个数值系列。');
  if (!Number.isInteger(clean.categoryColumn) || clean.categoryColumn < 0 || clean.categoryColumn >= data.headers.length) throw new Error('请选择有效的分类列和数值列。');
  const labels = data.rows.map((row, index) => {
    const label = row[clean.categoryColumn].trim();
    if (clean.chartType === 'scatter') {
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(label)) throw new Error(`第 ${index + 1} 条 X 轴数值缺失或格式无效；仅接受小数点数字。`);
      const value = Number(label);
      if (!Number.isFinite(value) || Math.abs(value) > 1e12 || value !== 0 && Math.abs(value) < 1e-9 || value === 0 && /[1-9]/.test(label.split(/[eE]/)[0])) throw new Error(`第 ${index + 1} 条 X 轴数值超出支持范围（绝对值 1e-9 至 1e12，或 0）。`);
      return label;
    }
    if (!label || label.length > 60 || /[\r\n\t]/.test(label)) throw new Error(`第 ${index + 1} 条分类标签需要 1–60 个字符且不换行。`);
    return label;
  });
  const parseSeries = (column: number): ChartSeries => ({
    label: data.headers[column],
    points: data.rows.map((row, index) => {
      const raw = row[column].trim();
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) throw new Error(`第 ${index + 1} 条「${data.headers[column]}」数值缺失或格式无效；仅接受小数点数字，不接受公式、百分号或千位分隔符。`);
      const value = Number(raw);
      if (!Number.isFinite(value) || Math.abs(value) > 1e12 || value !== 0 && Math.abs(value) < 1e-9 || value === 0 && /[1-9]/.test(raw.split(/[eE]/)[0])) throw new Error(`第 ${index + 1} 条「${data.headers[column]}」数值超出支持范围（绝对值 1e-9 至 1e12，或 0）。`);
      return { label: labels[index], value: Object.is(value, -0) ? 0 : value };
    }),
  });
  const series = valueColumns.map(parseSeries);
  if (clean.chartType === 'pie') {
    const values = series[0].points.map(point => point.value);
    if (values.some(value => value < 0)) throw new Error('饼图不支持负数，请改用柱状图或折线图。');
    if (!values.some(value => value > 0)) throw new Error('饼图至少需要一个大于 0 的数值。');
  }
  const points = series[0].points;
  const warnings: string[] = [];
  if (new Set(points.map(point => point.label)).size !== points.length) warnings.push(clean.chartType === 'scatter' ? 'X 值有重复：每一行仍单独绘制，没有自动汇总。' : '分类标签有重复：各行独立绘制，没有自动汇总。');
  series.forEach((current) => {
    const prefix = series.length > 1 ? `${current.label}：` : '';
    if (current.points.every(point => point.value === 0)) warnings.push(`${prefix}全部数值为 0，图形无法呈现数量差异。`);
    if (current.points.some(point => point.value < 0)) warnings.push(`${prefix}存在负值，请确认业务含义；坐标轴保留零基线。`);
    const nonzero = current.points.map(point => Math.abs(point.value)).filter(Boolean);
    if (nonzero.length && Math.max(...nonzero) / Math.min(...nonzero) > 1000) warnings.push(`${prefix}数值跨度超过 1000 倍，小值可能难以看清；可查看下方完整数据。`);
    if (clean.chartType === 'line' && current.points.length === 1) warnings.push(`${prefix}只有一个数据点，无法表达趋势。`);
  });
  if (!clean.unit) warnings.push('尚未填写单位，请确认数值量纲。');
  if (series.length > 1) {
    warnings.push('所有系列共用单位和坐标轴，请确认量纲一致；数值不自动堆叠或汇总。');
    const nonzero = series.flatMap(current => current.points.map(point => Math.abs(point.value))).filter(Boolean);
    if (nonzero.length && Math.max(...nonzero) / Math.min(...nonzero) > 1000) warnings.push('系列之间的数值跨度超过 1000 倍，小值可能难以看清；建议拆成不同图表。');
  }
  if (clean.chartType === 'line') warnings.push('折线按输入行顺序、等间距连接；请确认顺序有意义，日期间隔不会自动换算。');
  if (clean.chartType === 'scatter') warnings.push('散点按所选 X/Y 数值的真实比例绘制，不连线、不排序、不汇总；请确认各系列共用 X 轴的量纲。');
  const xValues = clean.chartType === 'scatter' ? data.rows.map(row => {
    const value = Number(row[clean.categoryColumn].trim());
    return Object.is(value, -0) ? 0 : value;
  }) : [];
  return { input: clean, points, series, xValues, warnings, categoryLabel: data.headers[clean.categoryColumn], valueLabel: data.headers[clean.valueColumn], valueLabels: valueColumns.map(column => data.headers[column]) };
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
const numberText = (value: number) => value === 0 ? '0' : Math.abs(value) >= 1e6 || Math.abs(value) < 0.001 ? value.toExponential(2) : Number(value.toPrecision(5)).toString();

export function renderChartSvg(chart: CheckedChart): string {
  const { input, points, series, valueLabels } = chart;
  const colors = ['#2563eb', '#d97706', '#059669', '#9333ea', '#dc2626', '#0891b2'];
  const width = Math.max(800, points.length * 74 + 160, Array.from(input.title).length * 23 + 160, (Math.max(...valueLabels.map(label => label.length)) + input.unit.length + 10) * 14 + 160);
  const height = 644;
  const left = 110, right = width - 40, top = 110, bottom = 430;
  const allPoints = series.flatMap(current => current.points);
  let low = Math.min(0, ...allPoints.map(point => point.value)), high = Math.max(0, ...allPoints.map(point => point.value));
  if (low === high) high = 1;
  const span = high - low; high += span * 0.08; if (low < 0) low -= span * 0.08;
  const y = (value: number) => bottom - (value - low) / (high - low) * (bottom - top);
  const slot = (right - left) / points.length, x = (index: number) => left + slot * (index + 0.5);
  const tag = (x: number, y: number, text: string, attrs = '') => `<text x="${x}" y="${y}" ${attrs}>${escapeXml(text)}</text>`;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="chart-title chart-description">`,
    `<title id="chart-title">${escapeXml(input.title)}</title><desc id="chart-description">${escapeXml(series.map(current => `${current.label}: ${current.points.map(point => `${point.label} ${point.value}`).join('，')}`).join('；'))}</desc>`,
    '<rect width="100%" height="100%" fill="#ffffff"/>', '<g font-family="Microsoft YaHei, Arial, sans-serif" font-size="13" fill="#243449">',
    tag(left, 38, input.title, 'font-size="22" font-weight="bold"'), tag(left, 72, `${series.length > 1 ? `${series.length} 个数值系列` : valueLabels[0]}${input.unit ? `（${input.unit}）` : ''} · ${{ bar: '柱状图', horizontal_bar: '水平条形图', line: '折线图', pie: '饼图', scatter: '散点图' }[input.chartType]}`)];
  if (input.chartType === 'pie') {
    const width = Math.max(640, Array.from(input.title).length * 14 + 160, Array.from(valueLabels[0]).length * 13 + 160);
    const centerX = Math.min(300, width / 2), centerY = 270, radius = 130;
    const height = 520 + points.length * 24;
    const total = points.reduce((sum, point) => sum + point.value, 0);
    parts[0] = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="chart-title chart-description">`;
    parts[1] = `<title id="chart-title">${escapeXml(input.title)}</title><desc id="chart-description">${escapeXml(points.map(point => `${point.label} ${point.value}（${(point.value / total * 100).toFixed(1)}%）`).join('；'))}</desc>`;
    parts.push('<circle cx="' + centerX + '" cy="' + centerY + '" r="' + radius + '" fill="#f1f5f9"/>');
    let angle = -Math.PI / 2;
    points.forEach((point, index) => {
      if (point.value <= 0) return;
      const next = angle + point.value / total * Math.PI * 2;
      const x1 = centerX + radius * Math.cos(angle), y1 = centerY + radius * Math.sin(angle);
      const x2 = centerX + radius * Math.cos(next), y2 = centerY + radius * Math.sin(next);
      const percentage = point.value / total * 100;
      if (percentage >= 99.999999) parts.push(`<circle data-category="${escapeXml(point.label)}" cx="${centerX}" cy="${centerY}" r="${radius}" fill="${colors[index % colors.length]}"><title>${escapeXml(`${point.label}: ${point.value} (${percentage.toFixed(1)}%)`)}</title></circle>`);
      else parts.push(`<path data-category="${escapeXml(point.label)}" d="M ${centerX} ${centerY} L ${x1} ${y1} A ${radius} ${radius} 0 ${next - angle > Math.PI ? 1 : 0} 1 ${x2} ${y2} Z" fill="${colors[index % colors.length]}" stroke="#ffffff" stroke-width="1"><title>${escapeXml(`${point.label}: ${point.value} (${percentage.toFixed(1)}%)`)}</title></path>`);
      angle = next;
    });
    points.forEach((point, index) => {
      const x = 24, y = 500 + index * 24;
      const percentage = (point.value / total * 100).toFixed(1);
      parts.push(`<rect x="${x}" y="${y - 11}" width="12" height="12" fill="${colors[index % colors.length]}"/>`,
        `<g><title>${escapeXml(`${point.label}: ${point.value} (${percentage}%)`)}</title>${tag(x + 20, y, `${Array.from(point.label).slice(0, 34).join('')}${Array.from(point.label).length > 34 ? '…' : ''} · ${numberText(point.value)} · ${percentage}%`)}</g>`);
    });
    parts.push('</g></svg>');
    return parts.join('');
  }
  if (input.chartType === 'horizontal_bar') {
    const labelWidth = Math.min(300, Math.max(140, Math.max(...points.map(point => Array.from(point.label).length)) * 7 + 24));
    const plotLeft = labelWidth + 24, plotRight = width - 40, plotTop = 112;
    const rowHeight = 28, plotBottom = plotTop + points.length * rowHeight, chartHeight = plotBottom + 130;
    const x = (value: number) => plotLeft + (value - low) / (high - low) * (plotRight - plotLeft);
    parts[0] = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${chartHeight}" viewBox="0 0 ${width} ${chartHeight}" role="img" aria-labelledby="chart-title chart-description">`;
    for (let tick = 0; tick <= 4; tick++) {
      const value = low + (high - low) * tick / 4, xx = x(value);
      parts.push(`<line x1="${xx}" x2="${xx}" y1="${plotTop - 8}" y2="${plotBottom}" stroke="#e2e8f0"/>`, tag(xx, plotBottom + 20, numberText(value), 'text-anchor="middle"'));
    }
    parts.push(`<line x1="${x(0)}" x2="${x(0)}" y1="${plotTop - 8}" y2="${plotBottom}" stroke="#64748b" stroke-width="1.5"/>`);
    series.forEach((current, seriesIndex) => current.points.forEach((point, index) => {
      const groupHeight = rowHeight * .78, barHeight = groupHeight / series.length * .82;
      const yy = plotTop + index * rowHeight - groupHeight / 2 + seriesIndex * groupHeight / series.length + (groupHeight / series.length - barHeight) / 2;
      const zero = x(0), valueX = x(point.value);
      parts.push(`<rect data-series="${escapeXml(current.label)}" data-category="${escapeXml(point.label)}" x="${Math.min(zero, valueX)}" y="${yy}" width="${Math.abs(valueX - zero)}" height="${barHeight}" fill="${colors[seriesIndex % colors.length]}"><title>${escapeXml(`${current.label} · ${point.label}: ${point.value}`)}</title></rect>`);
      if (series.length === 1) parts.push(tag(point.value < 0 ? valueX - 6 : valueX + 6, yy + barHeight / 2 + 4, numberText(point.value), `text-anchor="${point.value < 0 ? 'end' : 'start'}" font-size="11"`));
    }));
    points.forEach((point, index) => {
      const yy = plotTop + index * rowHeight + 4, chars = Array.from(point.label);
      const label = chars.length > 36 ? `${chars.slice(0, 35).join('')}…` : point.label;
      parts.push(`<g><title>${escapeXml(point.label)}</title>${tag(plotLeft - 10, yy, label, 'text-anchor="end"')}</g>`);
    });
    series.forEach((current, index) => {
      const legendX = plotLeft + (index % 3) * 220, legendY = plotBottom + 78 + Math.floor(index / 3) * 26;
      parts.push(`<rect x="${legendX}" y="${legendY - 11}" width="12" height="12" fill="${colors[index % colors.length]}"/>`,
        `<g><title>${escapeXml(current.label)}</title>${tag(legendX + 20, legendY, Array.from(current.label).length > 22 ? `${Array.from(current.label).slice(0, 21).join('')}…` : current.label)}</g>`);
    });
    parts.push(tag(plotLeft, chartHeight - 18, '按输入顺序绘制 · 完整数值见数据表或条目标题'), '</g></svg>');
    return parts.join('');
  }
  if (input.chartType === 'scatter') {
    const xValues = chart.xValues;
    const yValues = series.flatMap(current => current.points.map(point => point.value));
    const extent = (values: number[]) => {
      let min = Math.min(...values), max = Math.max(...values);
      if (min === max) { const pad = Math.max(Math.abs(min) * .08, 1); min -= pad; max += pad; }
      else { const pad = (max - min) * .06; min -= pad; max += pad; }
      return { min, max };
    };
    const xRange = extent(xValues), yRange = extent(yValues);
    const plotLeft = 110, plotRight = width - 45, plotTop = 120, plotBottom = 450;
    const x = (value: number) => plotLeft + (value - xRange.min) / (xRange.max - xRange.min) * (plotRight - plotLeft);
    const y = (value: number) => plotBottom - (value - yRange.min) / (yRange.max - yRange.min) * (plotBottom - plotTop);
    for (let tick = 0; tick <= 4; tick++) {
      const xv = xRange.min + (xRange.max - xRange.min) * tick / 4, yv = yRange.min + (yRange.max - yRange.min) * tick / 4;
      const xx = x(xv), yy = y(yv);
      parts.push(`<line x1="${xx}" x2="${xx}" y1="${plotTop}" y2="${plotBottom}" stroke="#e2e8f0"/>`, tag(xx, plotBottom + 22, numberText(xv), 'text-anchor="middle"'));
      parts.push(`<line x1="${plotLeft}" x2="${plotRight}" y1="${yy}" y2="${yy}" stroke="#e2e8f0"/>`, tag(plotLeft - 12, yy + 4, numberText(yv), 'text-anchor="end"'));
    }
    parts.push(`<line x1="${plotLeft}" x2="${plotRight}" y1="${plotBottom}" y2="${plotBottom}" stroke="#64748b"/>`,
      `<line x1="${plotLeft}" x2="${plotLeft}" y1="${plotTop}" y2="${plotBottom}" stroke="#64748b"/>`,
      tag((plotLeft + plotRight) / 2, plotBottom + 50, chart.categoryLabel, 'text-anchor="middle"'),
      `<text x="24" y="${(plotTop + plotBottom) / 2}" transform="rotate(-90 24 ${(plotTop + plotBottom) / 2})" text-anchor="middle">${escapeXml(series.length === 1 ? valueLabels[0] : '数值')}</text>`);
    series.forEach((current, seriesIndex) => current.points.forEach((point, index) => {
      const cx = x(xValues[index]), cy = y(point.value), color = colors[seriesIndex % colors.length];
      parts.push(`<circle data-series="${escapeXml(current.label)}" data-x="${xValues[index]}" data-y="${point.value}" cx="${cx}" cy="${cy}" r="5" fill="${color}"><title>${escapeXml(`${current.label} · ${chart.categoryLabel} ${xValues[index]} · ${current.label} ${point.value}`)}</title></circle>`);
    }));
    series.forEach((current, index) => {
      const legendX = plotLeft + (index % 3) * 220, legendY = 520 + Math.floor(index / 3) * 26;
      parts.push(`<circle cx="${legendX + 6}" cy="${legendY - 4}" r="5" fill="${colors[index % colors.length]}"/>`,
        `<g><title>${escapeXml(current.label)}</title>${tag(legendX + 20, legendY, current.label)}</g>`);
    });
    parts.push(tag(plotLeft, height - 24, '按 CSV 原始行一一对应 X/Y 值 · 不自动拟合或聚合'), '</g></svg>');
    return parts.join('');
  }
  for (let tick = 0; tick <= 4; tick++) {
    const value = low + (high - low) * tick / 4, yy = y(value);
    parts.push(`<line x1="${left}" x2="${right}" y1="${yy}" y2="${yy}" stroke="#e2e8f0"/>`, tag(left - 12, yy + 4, numberText(value), 'text-anchor="end"'));
  }
  parts.push(`<line x1="${left}" x2="${right}" y1="${y(0)}" y2="${y(0)}" stroke="#64748b" stroke-width="1.5"/>`);
  series.forEach((current, seriesIndex) => {
    const color = colors[seriesIndex % colors.length];
    if (input.chartType === 'line') parts.push(`<polyline data-series="${escapeXml(current.label)}" points="${current.points.map((point, index) => `${x(index)},${y(point.value)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="2.5"/>`);
    current.points.forEach((point, index) => {
      const xx = x(index), yy = y(point.value);
      if (input.chartType === 'bar') {
        const groupWidth = slot * .78, barWidth = groupWidth / series.length * .82;
        const barX = xx - groupWidth / 2 + seriesIndex * groupWidth / series.length + (groupWidth / series.length - barWidth) / 2;
        parts.push(`<rect x="${barX}" y="${Math.min(yy, y(0))}" width="${barWidth}" height="${Math.abs(yy - y(0))}" fill="${color}"><title>${escapeXml(`${current.label} · ${point.label}: ${point.value}`)}</title></rect>`);
      } else parts.push(`<circle cx="${xx}" cy="${yy}" r="4" fill="${color}"><title>${escapeXml(`${current.label} · ${point.label}: ${point.value}`)}</title></circle>`);
      if (series.length === 1) parts.push(tag(xx, point.value < 0 ? yy + 18 : yy - 10, numberText(point.value), 'text-anchor="middle" font-size="11"'));
    });
  });
  points.forEach((point, index) => {
    const xx = x(index);
    const label = Array.from(point.label); const clipped = label.length > 10 ? label.slice(0, 9).join('') + '…' : point.label;
    parts.push(tag(xx, bottom + 24, clipped, `text-anchor="end" transform="rotate(-40 ${xx} ${bottom + 24})"`));
  });
  series.forEach((current, index) => {
    const legendX = left + (index % 3) * 220, legendY = bottom + 125 + Math.floor(index / 3) * 28;
    const label = Array.from(current.label);
    parts.push(`<line x1="${legendX}" x2="${legendX + 18}" y1="${legendY}" y2="${legendY}" stroke="${colors[index]}" stroke-width="3"/>`,
      `<g><title>${escapeXml(current.label)}</title>${tag(legendX + 24, legendY + 4, label.length > 13 ? `${label.slice(0, 12).join('')}…` : current.label)}</g>`);
  });
  parts.push(tag(left, height - 24, '按输入顺序绘制 · 完整数值见数据表或点位标题'), '</g></svg>');
  return parts.join('');
}
