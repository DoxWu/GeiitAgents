import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { LoginDiagnostics } from '../LoginDiagnostics';
import { finishLoginDiagnostic, type LoginDiagnostic } from '@/services/loginDiagnostics';
const attempt: LoginDiagnostic = { phase: 'sending', url: 'https://org.example/api/v1/auth/login', startedAt: new Date().toISOString() };
afterEach(cleanup);

it('distinguishes unsubmitted forms from attempts awaiting a response', () => {
  const view = render(<LoginDiagnostics attempt={null} />);
  expect(screen.getByRole('status')).toHaveTextContent('尚未发起登录请求');
  view.rerender(<LoginDiagnostics attempt={attempt} />);
  expect(screen.getByRole('status')).toHaveTextContent('正在发起登录请求');
  expect(screen.getByRole('status')).toHaveTextContent(`POST ${attempt.url}`);
});
it.each([401, 403, 404, 429, 502])('shows an actual HTTP %s response and correlation ID', status => {
  render(<LoginDiagnostics attempt={finishLoginDiagnostic(attempt, Object.assign(new Error('fixture'), { status, requestId: 'request-fixture' }))} />);
  expect(screen.getByRole('status')).toHaveTextContent(`HTTP ${status}`);
  expect(screen.getByRole('status')).toHaveTextContent('request-fixture');
});
it('does not invent a status or claim server receipt when fetch rejects', () => {
  const result = finishLoginDiagnostic(attempt, new TypeError('Failed to fetch: fixture-secret'));
  render(<LoginDiagnostics attempt={result} />);
  expect(screen.getByRole('status')).toHaveTextContent('HTTP 状态码不可用');
  expect(screen.getByRole('status')).toHaveTextContent('无法确认服务器是否收到');
  expect(JSON.stringify(result)).not.toContain('fixture-secret');
  expect(result).not.toHaveProperty('status');
});
it('reports timeout independently from server switching cancellation', () => {
  const error = new DOMException('aborted', 'AbortError');
  expect(finishLoginDiagnostic(attempt, error, true).phase).toBe('timeout');
  expect(finishLoginDiagnostic(attempt, error).phase).toBe('cancelled');
});
