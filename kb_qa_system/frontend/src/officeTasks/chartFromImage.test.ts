import { expect, it } from 'vitest';
import { parseChartImageDraft } from './chartFromImage';

const draft = { title: '收入与成本', chartType: 'line', unit: '万元', csv: '月份,收入,成本\n一月,20,5\n二月,30,8', categoryColumn: 0, valueColumns: [1, 2], notes: ['成本数据为估读，请复核。'] };
it('checks multi-series image data with the local renderer and preserves recognition notes', () => {
  const { notes, ...input } = draft;
  expect(parseChartImageDraft('```json\n' + JSON.stringify(draft) + '\n```')).toEqual({ input: { ...input, valueColumn: 1 }, notes });
});
it('rejects truncated output and unreadable images without rendering model markup', () => {
  expect(() => parseChartImageDraft('{"title":')).toThrow('完整');
  expect(() => parseChartImageDraft('{"error":"<script>unsafe</script>"}')).toThrow('无法可靠识别');
});
it('rejects unsupported chart types, invalid columns and invalid numeric cells', () => {
  for (const patch of [{ chartType: 'script' }, { valueColumns: [12] }, { valueColumns: [1, 1] }, { csv: '月份,值\n一月,=1+2', valueColumns: [1] }, { categoryColumn: '0' }]) {
    expect(() => parseChartImageDraft(JSON.stringify({ ...draft, ...patch }))).toThrow();
  }
});
it('applies chart row and response size bounds before previewing', () => {
  expect(() => parseChartImageDraft(' '.repeat(150001))).toThrow('过大');
  expect(() => parseChartImageDraft(JSON.stringify({ ...draft, valueColumns: [1], csv: '分类,值\n' + Array.from({ length: 51 }, (_, index) => `点${index},${index}`).join('\n') }))).toThrow('50');
});
