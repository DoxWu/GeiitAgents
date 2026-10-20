import { safeStorage } from '@/utils/safeStorage';
import { USER_STORAGE_KEY } from '@/utils/constants';
import { getAccountServer } from './accountServer';

export type RerankMode = 'current' | 'qwen3.7-text-rerank';

function currentUserId(): number | undefined {
  try {
    const user = JSON.parse(safeStorage.getItem(USER_STORAGE_KEY) || 'null');
    return Number.isSafeInteger(user?.id) && user.id > 0 ? user.id : undefined;
  } catch { return undefined; }
}

function preferenceKey(userId: number) {
  return `kb_rerank:${getAccountServer()}:${userId}`;
}

export function getRerankMode(userId = currentUserId()): RerankMode {
  return userId && safeStorage.getItem(preferenceKey(userId)) === 'qwen3.7-text-rerank'
    ? 'qwen3.7-text-rerank' : 'current';
}

export function setRerankMode(userId: number, mode: RerankMode) {
  safeStorage.setItem(preferenceKey(userId), mode);
}

// Omitting the default keeps older servers and existing callers compatible.
export function rerankRequestPreference(): { rerank_mode?: RerankMode } {
  const mode = getRerankMode();
  return mode === 'current' ? {} : { rerank_mode: mode };
}
