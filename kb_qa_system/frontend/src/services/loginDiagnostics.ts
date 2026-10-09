export interface LoginDiagnostic {
  phase: 'sending' | 'http-response' | 'no-response' | 'timeout' | 'cancelled' | 'succeeded';
  url: string;
  startedAt: string;
  durationMs?: number;
  status?: number;
  requestId?: string;
}

// This record deliberately contains no username, password, headers or body.
export function finishLoginDiagnostic(attempt: LoginDiagnostic, error?: unknown, timedOut = false): LoginDiagnostic {
  const durationMs = Math.max(0, Date.now() - Date.parse(attempt.startedAt));
  if (!error) return { ...attempt, phase: 'succeeded', durationMs };
  const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' && error.status >= 100 ? error.status : undefined;
  const requestId = error && typeof error === 'object' && 'requestId' in error && typeof error.requestId === 'string' ? error.requestId : undefined;
  return { ...attempt, durationMs, phase: status ? 'http-response' : timedOut ? 'timeout' : error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'no-response', ...(status ? { status } : {}), ...(requestId ? { requestId } : {}) };
}
