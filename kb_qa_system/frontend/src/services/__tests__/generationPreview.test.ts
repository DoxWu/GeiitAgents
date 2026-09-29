import { afterEach, expect, it, vi } from 'vitest';
import { generationPreview, PREVIEW_CHARACTERS } from '../generationPreview';

afterEach(() => vi.useRealTimers());
it('shows the first chunk immediately and batches subsequent bounded previews', () => {
  vi.useFakeTimers(); const emit = vi.fn(), controller = new AbortController();
  const preview = generationPreview(controller.signal, () => true, emit);
  preview.push('开始'); expect(emit).toHaveBeenCalledExactlyOnceWith({ text: '开始', characters: 2 });
  for (let i = 0; i < 100; i++) preview.push('x'.repeat(1000));
  expect(emit).toHaveBeenCalledTimes(1); vi.advanceTimersByTime(60);
  expect(emit).toHaveBeenCalledTimes(2); expect(emit.mock.lastCall![0].text).toHaveLength(PREVIEW_CHARACTERS);
  expect(emit.mock.lastCall![0].characters).toBe(100002); preview.dispose();
});
it.each(['abort', 'dispose', 'inactive'])('discards queued output on %s', reason => {
  vi.useFakeTimers(); let active = true;
  const emit = vi.fn(), controller = new AbortController(), preview = generationPreview(controller.signal, () => active, emit);
  preview.push('first'); preview.push('pending');
  if (reason === 'abort') controller.abort(); else if (reason === 'dispose') preview.dispose(); else active = false;
  emit.mockClear(); vi.advanceTimersByTime(100); preview.push('late'); expect(emit).not.toHaveBeenCalled(); preview.dispose();
});
