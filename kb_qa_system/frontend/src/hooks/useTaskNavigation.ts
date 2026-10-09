import { useCallback, useEffect, useRef } from 'react';

export function useTaskNavigation(taskId: string | undefined) {
  const resultRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLDivElement>(null);
  const showResult = useCallback(() => {
    resultRef.current?.scrollIntoView?.({ block: 'start', behavior: 'auto' });
    resultRef.current?.focus({ preventScroll: true });
  }, []);
  const showInput = useCallback(() => {
    inputRef.current?.scrollIntoView?.({ block: 'start', behavior: 'auto' });
    inputRef.current?.focus({ preventScroll: true });
  }, []);
  // Only a different selected run moves the viewport; streaming updates do not.
  useEffect(() => { if (taskId) showResult(); }, [taskId, showResult]);
  return { resultRef, inputRef, showResult, showInput };
}
