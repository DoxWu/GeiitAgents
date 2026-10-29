import { useCallback, useEffect, useRef } from 'react';
import { useWorkbenchStore } from '@/store/workbenchStore';
import { useAuthStore } from '@/store/authStore';
import { getAccountGeneration, subscribeAccountServer } from '@/services/accountServer';

/** Fence local UI continuations across lock/unlock, account changes and unmount. */
export function useWorkbenchFence() {
  const lifetime = useRef({ mounted: false, generation: 0 });
  useEffect(() => {
    const state = lifetime.current; state.mounted = true;
    const invalidate = () => { state.generation++; };
    const stopVault = useWorkbenchStore.subscribe((state, previous) => { if (state.unlocked !== previous.unlocked) invalidate(); });
    const stopAuth = useAuthStore.subscribe((state, previous) => { if (state.user?.id !== previous.user?.id || state.isAuthenticated !== previous.isAuthenticated) invalidate(); });
    const stopServer = subscribeAccountServer(invalidate);
    return () => { state.mounted = false; invalidate(); stopVault(); stopAuth(); stopServer(); };
  }, []);
  return useCallback(() => {
    const generation = lifetime.current.generation, account = getAccountGeneration();
    return () => lifetime.current.mounted && generation === lifetime.current.generation
      && account === getAccountGeneration() && useWorkbenchStore.getState().unlocked;
  }, []);
}
