import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CircleHelp } from 'lucide-react';

/** Portals avoid clipping by canvas/scroll panels. Also works with touch and keyboard. */
export function Hint({ label, children }: { label: string; children: ReactNode }) {
  const id = useId(), anchor = useRef<HTMLButtonElement>(null), bubble = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false), [pinned, setPinned] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); }, []);
  const open = hovered || focused || pinned;
  const enterBubble = () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); setHovered(true); };
  const leaveBubble = () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); hoverTimer.current = setTimeout(() => setHovered(false), 100); };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const a = anchor.current?.getBoundingClientRect(), b = bubble.current?.getBoundingClientRect();
      if (!a || !b) return;
      setPosition({ left: Math.max(8, Math.min(a.left, window.innerWidth - b.width - 8)),
        top: Math.max(8, a.bottom + b.height + 16 <= window.innerHeight ? a.bottom + 8 : a.top - b.height - 8) });
    };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = () => { setPinned(false); setHovered(false); setFocused(false); };
    const outside = (e: PointerEvent) => { if (!anchor.current?.contains(e.target as Node) && !bubble.current?.contains(e.target as Node)) close(); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true); };
  }, [open]);
  return <><button type="button" ref={anchor} aria-label={label + '说明'} aria-describedby={open ? id : undefined}
    className="inline-flex shrink-0 items-center justify-center rounded-full p-1 align-middle text-ink-secondary hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
    onMouseEnter={enterBubble} onMouseLeave={leaveBubble} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
    onClick={e => { e.preventDefault(); e.stopPropagation(); setPinned(!pinned); setFocused(false); setHovered(false); }}><CircleHelp size={14} aria-hidden="true" /></button>
    {open && createPortal(<div ref={bubble} id={id} role="tooltip" style={{ position: 'fixed', ...position, maxWidth: 'min(340px, calc(100vw - 16px))', zIndex: 10000 }}
      onMouseEnter={enterBubble} onMouseLeave={leaveBubble}
      className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-surface px-3 py-2 text-left text-xs font-normal leading-relaxed text-ink shadow-xl">{children}</div>, document.body)}</>;
}
