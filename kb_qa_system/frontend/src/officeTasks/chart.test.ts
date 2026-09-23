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
it('supports all-negative, all-zero and categorical line data without invalid geometry', () => {
  for (const csv of ['a,b\nx,0\ny,0', 'a,b\nx,-1\ny,-2', 'a,b\nx,1e-9\ny,1e12']) {
    const svg = renderChartSvg(checkChart({ ...input, csv, chartType: 'line' }));
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(doc.querySelector('parsererror')).toBeNull(); expect(doc.querySelectorAll('circle')).toHaveLength(2);
    expect(doc.querySelector('polyline')?.getAttribute('points')?.split(' ')).toHaveLength(2);
    expect(svg).not.toMatch(/NaN|Infinity/);
  }
});
