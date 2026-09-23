import { expect, it } from 'vitest';
import { compareArtifactText } from './artifactDiff';

function assertReconstructs(before: string, after: string) {
  const diff = compareArtifactText(before, after);
  expect(diff.mode).not.toBe('too-large');
  if (diff.identical) { expect(before).toBe(after); return diff; }
  expect(diff.rows.filter(row => row.kind !== 'add').map(row => row.text).join('')).toBe(before);
  expect(diff.rows.filter(row => row.kind !== 'remove').map(row => row.text).join('')).toBe(after);
  expect(diff.rows.filter(row => row.beforeLine).map(row => row.beforeLine)).toEqual(Array.from({ length: diff.rows.filter(row => row.beforeLine).length }, (_, index) => index + 1));
  expect(diff.rows.filter(row => row.afterLine).map(row => row.afterLine)).toEqual(Array.from({ length: diff.rows.filter(row => row.afterLine).length }, (_, index) => index + 1));
  return diff;
}
it('aligns unchanged Chinese lines around additions and removals', () => {
  const diff = assertReconstructs('# 周报\n旧计划\n保留\n结尾\n', '# 周报\n新计划\n保留\n补充\n结尾\n');
  expect(diff).toMatchObject({ mode: 'exact', added: 2, removed: 1 });
  expect(diff.rows.filter(row => row.kind === 'equal').map(row => row.text)).toEqual(['# 周报\n', '保留\n', '结尾\n']);
});
it('distinguishes whitespace, CRLF, empty lines and missing final newlines', () => {
  for (const [a, b] of [['x\r\n', 'x\n'], ['x', 'x\n'], [' x\n', 'x\n'], ['x\n\n', 'x\n'], ['', '\n'], ['\n', ''], ['😀\n', '中文\n']]) {
    const diff = assertReconstructs(a, b); expect(diff.identical).toBe(false); expect(diff.added + diff.removed).toBeGreaterThan(0);
  }
});
it('round trips repeated-line combinations without dropping or duplicating text', () => {
  const choices = ['', 'a\n', 'b\r\n', '\n', '<img src=x>'];
  const samples = choices.flatMap(first => choices.map(second => first + second));
  for (const before of samples) for (const after of samples) assertReconstructs(before, after);
});
it('handles large identical documents without a diff allocation', () => {
  const text = '中文\n'.repeat(200000);
  expect(compareArtifactText(text, text)).toMatchObject({ identical: true, mode: 'exact', rows: [] });
});
it('degrades large changed ranges to a declared replacement while preserving both texts', () => {
  const a = 'start\n' + Array.from({ length: 1100 }, (_, index) => `old${index}\n`).join('') + 'end\n';
  const b = 'start\n' + Array.from({ length: 1100 }, (_, index) => `new${index}\n`).join('') + 'end\n';
  expect(assertReconstructs(a, b)).toMatchObject({ mode: 'coarse', added: 1100, removed: 1100 });
});
it('declines large inputs before building a quadratic comparison matrix', () => {
  expect(compareArtifactText('a'.repeat(200001), 'b'.repeat(200001))).toMatchObject({ identical: false, mode: 'too-large', rows: [] });
  expect(compareArtifactText('a\n'.repeat(6000), 'b\n'.repeat(6000))).toMatchObject({ mode: 'too-large', rows: [] });
});
