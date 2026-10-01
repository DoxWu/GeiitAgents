import { expect, it } from 'vitest';
import { checkChart, parseChartCsv, renderChartSvg, type ChartInput } from './chart';
const input: ChartInput = { title: '测试图表', unit: '元', chartType: 'bar', csv: '分类,数值\n一月,12\n二月,-4\n三月,0', categoryColumn: 0, valueColumn: 1 };

it('reads BOM, CRLF, escaped quotes, quoted commas, embedded newlines and a final delimiter', () => {
  expect(parseChartCsv('\uFEFF分类,数值,备注\r\n"a,b",2,"第一行\n第二行"\r\n"a""b",3,')).toEqual({ headers: ['分类', '数值', '备注'], rows: [['a,b', '2', '第一行\n第二行'], ['a"b', '3', '']] });
});
it('rejects malformed quotes, blank records, mismatched columns, duplicate headers and bounds', () => {
  for (const source of ['分类,数值\n"a,2', '分类,数值\na"b,2', '分类,数值\n"a"x,2', 'a,b\nx,2\n\n', 'a,a\nx,2', 'a,b\nx,2,3', 'a,b\n\0,2', 'a,b\n' + 'x,2\n'.repeat(51), 'a,b\n' + 'x'.repeat(2001) + ',2']) expect(() => parseChartCsv(source)).toThrow();
});
it('requires explicit numeric input instead of guessing missing, localized or formula cells', () => {
  for (const value of ['', ' ', '=SUM(1:2)', 'NaN', 'Infinity', '10%', '0x10', '"1,200"', '1e999', '1e-999', '1e13', '1e-10']) {
    expect(() => checkChart({ ...input, csv: `分类,数值\n一月,${value}` })).toThrow('数值');
  }
  expect(checkChart({ ...input, csv: '分类,数值\n一月,+1.2e2\n二月,-0\n三月,.25' }).points.map(point => point.value)).toEqual([120, 0, .25]);
});
it('checks selected columns and preserves duplicate rows without aggregation or sorting', () => {
  const result = checkChart({ ...input, csv: '数值,其他,分类\n4,no,重复\n2,no,重复', categoryColumn: 2, valueColumn: 0 });
  expect(result.points).toEqual([{ label: '重复', value: 4 }, { label: '重复', value: 2 }]);
  expect(result.warnings).toContain('分类标签有重复：各行独立绘制，没有自动汇总。');
  for (const column of [-1, 3, 0.5]) expect(() => checkChart({ ...input, valueColumn: column })).toThrow('有效');
  expect(() => checkChart({ ...input, valueColumn: 0 })).toThrow('不能相同');
});
it('supports multiple numeric series while preserving the legacy first-series fields', () => {
  const result = checkChart({ ...input, csv: '月份,收入,成本\n一月,10,4\n二月,20,8', valueColumns: [1, 2] });
  expect(result.input.valueColumn).toBe(1);
  expect(result.input.valueColumns).toEqual([1, 2]);
  expect(result.valueLabels).toEqual(['收入', '成本']);
  expect(result.series.map(series => series.points.map(point => point.value))).toEqual([[10, 20], [4, 8]]);
  expect(result.warnings).toContain('所有系列共用单位和坐标轴，请确认量纲一致；数值不自动堆叠或汇总。');
  const doc = new DOMParser().parseFromString(renderChartSvg(result), 'image/svg+xml');
  expect(doc.querySelectorAll('rect')).toHaveLength(5);
  expect(doc.querySelectorAll('line[stroke-width="3"]')).toHaveLength(2);
  expect(Array.from(doc.querySelectorAll('rect title'), node => node.textContent)).toEqual(['收入 · 一月: 10', '收入 · 二月: 20', '成本 · 一月: 4', '成本 · 二月: 8']);
  expect(renderChartSvg(result)).not.toMatch(/NaN|Infinity/);
});
it('renders bounded pie slices with exact totals and rejects invalid pie input', () => {
  const chart = checkChart({ ...input, csv: '类别,占比\n甲,3\n乙,1\n丙,0', chartType: 'pie' });
  const svg = renderChartSvg(chart), doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  expect(doc.querySelector('parsererror')).toBeNull();
  expect(doc.querySelectorAll('path[data-category]')).toHaveLength(2);
  expect(doc.querySelector('path[data-category="甲"] title')?.textContent).toBe('甲: 3 (75.0%)');
  expect(doc.querySelector('path[data-category="乙"] title')?.textContent).toBe('乙: 1 (25.0%)');
  expect(doc.documentElement.textContent).toContain('丙 · 0 · 0.0%');
  expect(Number(doc.documentElement.getAttribute('width')) * Number(doc.documentElement.getAttribute('height'))).toBeLessThanOrEqual(2_500_000);
  for (const csv of ['类别,值\na,-1\nb,2', '类别,值\na,0\nb,0']) expect(() => checkChart({ ...input, csv, chartType: 'pie' })).toThrow();
  expect(() => checkChart({ ...input, csv: '类别,a,b\nx,1,2', chartType: 'pie', valueColumns: [1, 2] })).toThrow('一个数值系列');
});
it('renders a single positive pie slice as a circle and escapes category labels', () => {
  const doc = new DOMParser().parseFromString(renderChartSvg(checkChart({ ...input, csv: '类别,值\n<类别>,2', chartType: 'pie' })), 'image/svg+xml');
  expect(doc.querySelector('circle[data-category="<类别>"] title')?.textContent).toBe('<类别>: 2 (100.0%)');
  expect(doc.querySelector('path[data-category]')).toBeNull();
  expect(doc.querySelector('script,image,a,foreignObject')).toBeNull();
});
it('keeps long pie titles and column labels within the PNG source-area limit', () => {
  const chart = checkChart({ ...input, title: '标题'.repeat(40), csv: `类别,${'分类值'.repeat(20)}\na,1\nb,2`, chartType: 'pie' });
  const doc = new DOMParser().parseFromString(renderChartSvg(chart), 'image/svg+xml');
  expect(Number(doc.documentElement.getAttribute('width')) * Number(doc.documentElement.getAttribute('height'))).toBeLessThanOrEqual(2_500_000);
  expect(Number(doc.documentElement.getAttribute('width'))).toBeGreaterThan(640);
});
it('rejects more than six series and selections that include the category column', () => {
  const csv = ['类别', 'a', 'b', 'c', 'd', 'e', 'f', 'g'].join(',') + '\nx,1,2,3,4,5,6,7';
  expect(() => checkChart({ ...input, csv, valueColumns: [1, 2, 3, 4, 5, 6, 7] })).toThrow('1–6');
  expect(() => checkChart({ ...input, csv, valueColumns: [0, 1] })).toThrow('不能相同');
});
it('rejects empty, duplicate and invalid series selections instead of falling back', () => {
  for (const valueColumns of [[], [1, 1], [2], [-1], [NaN], [1.5]]) expect(() => checkChart({ ...input, valueColumns })).toThrow();
  const selection = [2, 1];
  const checked = checkChart({ ...input, csv: '分类,收入,支出\n一,20,10', valueColumns: selection });
  selection.reverse();
  expect(checked.input.valueColumns).toEqual([2, 1]);
  expect(checked.series.map(series => series.label)).toEqual(['支出', '收入']);
});
it('validates secondary series and flags cross-series scale differences', () => {
  const csv = '分类,收入,支出\n一,1000000,1\n二,2000000,2';
  expect(checkChart({ ...input, csv, valueColumns: [1, 2] }).warnings.join(' ')).toContain('系列之间');
  expect(() => checkChart({ ...input, csv: '分类,收入,支出\n一,20,=1+1', valueColumns: [1, 2] })).toThrow('「支出」数值缺失');
  expect(() => checkChart({ ...input, csv: '分类,收入,支出\n一,20,1e999', valueColumns: [1, 2] })).toThrow('「支出」数值超出');
});
it('uses a shared linear scale and keeps series colors for negative values', () => {
  const chart = checkChart({ ...input, csv: '分类,收入,支出\n一,10,20\n二,0,-10', valueColumns: [1, 2] });
  const doc = new DOMParser().parseFromString(renderChartSvg(chart), 'image/svg+xml');
  const bars = Array.from(doc.querySelectorAll('rect')).slice(1);
  expect(Number(bars[2].getAttribute('height')) / Number(bars[0].getAttribute('height'))).toBeCloseTo(2);
  expect(Number(bars[2].getAttribute('x'))).toBeGreaterThan(Number(bars[0].getAttribute('x')) + Number(bars[0].getAttribute('width')));
  expect(bars[2].getAttribute('fill')).toBe(bars[3].getAttribute('fill'));
  expect(bars[0].getAttribute('fill')).not.toBe(bars[2].getAttribute('fill'));
  const line = new DOMParser().parseFromString(renderChartSvg({ ...chart, input: { ...chart.input, chartType: 'line' } }), 'image/svg+xml');
  const lines = Array.from(line.querySelectorAll('polyline'));
  expect(lines).toHaveLength(2);
  expect(lines.map(node => node.getAttribute('points')?.split(' ').map(pair => pair.split(',')[0]))[0]).toEqual(lines[1].getAttribute('points')?.split(' ').map(pair => pair.split(',')[0]));
  expect(line.querySelectorAll('circle')).toHaveLength(4);
});
it('escapes series titles and keeps six series at fifty rows within PNG bounds', () => {
  const headers = Array.from({ length: 6 }, (_, i) => `<script${i}>` + '长'.repeat(40));
  const csv = ['分类,' + headers.join(','), ...Array.from({ length: 50 }, (_, i) => `分类${i},1,2,3,4,5,6`)].join('\n');
  const doc = new DOMParser().parseFromString(renderChartSvg(checkChart({ ...input, csv, valueColumns: [1, 2, 3, 4, 5, 6] })), 'image/svg+xml');
  expect(doc.querySelector('parsererror,script,image,a')).toBeNull();
  expect(doc.querySelectorAll('rect title')).toHaveLength(300);
  expect(doc.documentElement.textContent).toContain(headers[5]);
  expect(Number(doc.documentElement.getAttribute('width')) * Number(doc.documentElement.getAttribute('height'))).toBeLessThanOrEqual(2_500_000);
});
it('explains zero values, missing units, negative values, large dynamic range and categorical lines', () => {
  const zero = checkChart({ ...input, csv: '分类,数值\n一月,0', chartType: 'line', unit: '' });
  expect(zero.warnings).toHaveLength(4);
  const result = checkChart({ ...input, csv: '分类,数值\n一月,1e-6\n二月,-100' });
  expect(result.warnings.join(' ')).toMatch(/负值.*1000/);
});
it('emits valid inert SVG without executing markup from titles, labels or units', () => {
  const checked = checkChart({ ...input, title: '<script>alert(1)</script>', unit: '"<&', csv: '分类,数值\n<img src=x>,2\n第二行,-1' });
  const svg = renderChartSvg(checked), doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  expect(doc.querySelector('parsererror')).toBeNull();
  expect(doc.querySelector('script,image,a,foreignObject')).toBeNull();
  expect(doc.querySelectorAll('[href],[onclick],[onload]')).toHaveLength(0);
  expect(doc.documentElement.textContent).toContain('<script>alert(1)</script>');
  expect(svg).not.toMatch(/NaN|Infinity/);
  expect(renderChartSvg(checked)).toBe(svg);
});
it('renders zero-baseline bars with correct value ratios and negative direction', () => {
  const doc = new DOMParser().parseFromString(renderChartSvg(checkChart({ ...input, csv: '分类,数值\na,10\nb,20\nc,-10\nd,0' })), 'image/svg+xml');
  const bars = Array.from(doc.querySelectorAll('rect')).slice(1);
  expect(bars).toHaveLength(4);
  expect(Number(bars[1].getAttribute('height')) / Number(bars[0].getAttribute('height'))).toBeCloseTo(2);
  expect(Number(bars[2].getAttribute('height'))).toBeCloseTo(Number(bars[0].getAttribute('height')));
  expect(Number(bars[2].getAttribute('y'))).toBeGreaterThan(Number(bars[0].getAttribute('y')));
  expect(Number(bars[3].getAttribute('height'))).toBe(0);
});
it('renders multi-series horizontal bars with a shared zero baseline and bounded category labels', () => {
  const chart = checkChart({ ...input, chartType: 'horizontal_bar', csv: `类别,收入,成本\n${'长标签'.repeat(20)},10,-5\n第二项,-10,0` , valueColumns: [1, 2] });
  const doc = new DOMParser().parseFromString(renderChartSvg(chart), 'image/svg+xml');
  expect(doc.querySelector('parsererror')).toBeNull();
  expect(doc.querySelectorAll('rect[data-series]')).toHaveLength(4);
  expect(doc.querySelector('rect[data-series="收入"][data-category^="长标签"]')).toBeTruthy();
  expect(doc.querySelector('text')?.textContent).toBe('测试图表');
  expect(doc.documentElement.getAttribute('height')).toBe('298');
  expect(doc.documentElement.textContent).toContain('水平条形图');
  expect(doc.documentElement.outerHTML).not.toMatch(/NaN|Infinity/);
});
it('renders scatter plots with numeric X and Y axes, separate series, and no connecting lines', () => {
  const chart = checkChart({ ...input, chartType: 'scatter', csv: '时间,温度,湿度\n1,10,40\n2,30,80\n4,20,50', valueColumns: [1, 2] });
  expect(chart.categoryLabel).toBe('时间');
  expect(chart.points.map(point => point.label)).toEqual(['1', '2', '4']);
  expect(chart.warnings.join(' ')).toContain('真实比例绘制');
  const doc = new DOMParser().parseFromString(renderChartSvg(chart), 'image/svg+xml');
  expect(doc.querySelector('parsererror')).toBeNull();
  expect(doc.querySelectorAll('circle[data-series]')).toHaveLength(6);
  expect(doc.querySelectorAll('polyline')).toHaveLength(0);
  expect(doc.querySelector('text')?.textContent).toBe('测试图表');
  expect(doc.documentElement.textContent).toContain('时间');
  expect(doc.documentElement.textContent).toContain('散点图');
  expect(doc.querySelector('circle[data-series="温度"][data-x="1"][data-y="10"]')).toBeTruthy();
  expect(doc.querySelector('circle[data-series="湿度"][data-x="4"][data-y="50"]')).toBeTruthy();
  expect(doc.documentElement.outerHTML).not.toMatch(/NaN|Infinity/);
});
it('rejects nonnumeric, out-of-range, or overlapping scatter X selections', () => {
  for (const value of ['', '月一', '1%', '1e999', '1e-10']) {
    expect(() => checkChart({ ...input, chartType: 'scatter', csv: `X,Y\n${value},2` })).toThrow('X 轴数值');
  }
  expect(() => checkChart({ ...input, chartType: 'scatter', csv: 'X,Y\n1,2', categoryColumn: 1, valueColumn: 1 })).toThrow('不能相同');
});
it('preserves full numeric precision for scatter coordinates', () => {
  const chart = checkChart({ ...input, chartType: 'scatter', csv: 'X,Y\n1.123456789,2.123456789', valueColumn: 1 });
  expect(chart.xValues).toEqual([1.123456789]);
  const doc = new DOMParser().parseFromString(renderChartSvg(chart), 'image/svg+xml');
  expect(doc.querySelector('circle[data-series]')?.getAttribute('data-x')).toBe('1.123456789');
});
it('supports all-negative, all-zero and categorical line data without invalid geometry', () => {
  for (const csv of ['a,b\nx,0\ny,0', 'a,b\nx,-1\ny,-2', 'a,b\nx,1e-9\ny,1e12']) {
    const svg = renderChartSvg(checkChart({ ...input, csv, chartType: 'line' }));
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(doc.querySelector('parsererror')).toBeNull(); expect(doc.querySelectorAll('circle')).toHaveLength(2);
    expect(doc.querySelector('polyline')?.getAttribute('points')?.split(' ')).toHaveLength(2);
    expect(svg).not.toMatch(/NaN|Infinity/);
  }
});
