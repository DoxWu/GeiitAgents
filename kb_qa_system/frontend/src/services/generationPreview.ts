export interface GenerationPreview { text: string; characters: number }
export const PREVIEW_CHARACTERS = 16000;

/** Bound transient UI work; the transport retains and validates the full result. */
export function generationPreview(signal: AbortSignal, active: () => boolean, emit: (value: GenerationPreview | null) => void) {
  let text = '', characters = 0, closed = false, timer: ReturnType<typeof setTimeout> | undefined;
  function flush() {
    timer = undefined;
    if (!closed && !signal.aborted && active()) emit({ text, characters });
  }
  function dispose() {
    if (closed) return;
    closed = true; clearTimeout(timer); text = ''; characters = 0;
    signal.removeEventListener('abort', dispose); emit(null);
  }
  signal.addEventListener('abort', dispose, { once: true });
  return {
    push(chunk: string) {
      if (closed || signal.aborted || !active()) return;
      const first = characters === 0;
      characters += chunk.length;
      if (text.length < PREVIEW_CHARACTERS) text += chunk.slice(0, PREVIEW_CHARACTERS - text.length);
      if (first) flush(); else timer ??= setTimeout(flush, 60);
    },
    dispose,
  };
}
