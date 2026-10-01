import { expect, it } from 'vitest';
import { mergeNonOverlappingText } from './threeWayMerge';

it('combines independent additions, edits and deletions in the shared base order', () => {
  expect(mergeNonOverlappingText('A\nB\nC\n', 'A local\nB\nC\n', 'A\nB\nC remote\n')).toEqual({ ok: true, text: 'A local\nB\nC remote\n' });
  expect(mergeNonOverlappingText('A\nB\nC\n', 'A\nC\n', 'A\nB\nC remote\n')).toEqual({ ok: true, text: 'A\nC remote\n' });
  expect(mergeNonOverlappingText('A\nB\n', 'A\nB\nlocal\n', 'remote\nA\nB\n')).toEqual({ ok: true, text: 'remote\nA\nB\nlocal\n' });
});

it('accepts identical changes once and refuses overlaps or ambiguous same-position insertions', () => {
  expect(mergeNonOverlappingText('A\nB\n', 'A local\nB\n', 'A local\nB\n')).toEqual({ ok: true, text: 'A local\nB\n' });
  expect(mergeNonOverlappingText('A\nB\n', 'A local\nB\n', 'A remote\nB\n')).toEqual({ ok: false, reason: 'overlap' });
  expect(mergeNonOverlappingText('A\nB\n', 'A\nlocal\nB\n', 'A\nremote\nB\n')).toEqual({ ok: false, reason: 'overlap' });
});

it('rejects work beyond the bounded exact diff budget', () => {
  const base = Array.from({ length: 1100 }, (_, i) => `base ${i}\n`).join('');
  const changed = Array.from({ length: 1100 }, (_, i) => `local ${i}\n`).join('');
  expect(mergeNonOverlappingText(base, changed, base)).toEqual({ ok: false, reason: 'too-large' });
});
