import { afterEach, expect, it } from 'vitest';
import { getRerankMode, rerankRequestPreference, setRerankMode } from '../rerankPreference';
import { getAccountServer, setAccountServer } from '../accountServer';
import { safeStorage } from '@/utils/safeStorage';
import { USER_STORAGE_KEY } from '@/utils/constants';

const originalServer = getAccountServer();
afterEach(() => { setAccountServer(originalServer); localStorage.clear(); sessionStorage.clear(); });

it('defaults to existing behavior and isolates choices by user and server', () => {
  expect(getRerankMode(1)).toBe('current');
  expect(rerankRequestPreference()).toEqual({});
  setRerankMode(1, 'qwen3.7-text-rerank');
  expect(getRerankMode(1)).toBe('qwen3.7-text-rerank');
  expect(getRerankMode(2)).toBe('current');
  safeStorage.setItem(USER_STORAGE_KEY, JSON.stringify({ id: 1 }));
  expect(rerankRequestPreference()).toEqual({ rerank_mode: 'qwen3.7-text-rerank' });
  setAccountServer('https://another.example/api/v1');
  expect(getRerankMode(1)).toBe('current');
  setAccountServer(originalServer);
  expect(getRerankMode(1)).toBe('qwen3.7-text-rerank');
  setRerankMode(1, 'current');
  expect(getRerankMode(1)).toBe('current');
});

it('invalid stored user data cannot activate a paid API', () => {
  safeStorage.setItem(USER_STORAGE_KEY, '{');
  expect(rerankRequestPreference()).toEqual({});
  safeStorage.setItem(USER_STORAGE_KEY, '{"id":-1}');
  expect(rerankRequestPreference()).toEqual({});
});
