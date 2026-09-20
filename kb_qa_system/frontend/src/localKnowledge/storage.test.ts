import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { commitIndex, loadIndex } from './storage';
import { DEFAULT_PROFILE, fingerprint, type LocalIndex } from './core';
const sample = (revision: string): LocalIndex => ({ version: 1, revision, profile: DEFAULT_PROFILE,
  fingerprint: fingerprint(DEFAULT_PROFILE), documents: [], chunks: [], updatedAt: '' });
beforeEach(async () => { const old = await loadIndex(); if (old) await commitIndex(null, old.revision); });
describe('atomic independent local storage', () => {
  it('persists and replaces a completed index', async () => {
    await commitIndex(sample('a'), null); await commitIndex(sample('b'), 'a');
    expect((await loadIndex())?.revision).toBe('b');
  });
  it('preserves original on stale replacement or deletion', async () => {
    await commitIndex(sample('original'), null);
    await expect(commitIndex(sample('new'), 'stale')).rejects.toThrow('另一个窗口');
    await expect(commitIndex(null, 'stale')).rejects.toThrow();
    expect((await loadIndex())?.revision).toBe('original');
  });
  it('permits only one concurrent commit for a version', async () => {
    const results = await Promise.allSettled([commitIndex(sample('one'), null), commitIndex(sample('two'), null)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await loadIndex())?.revision).toBe('one');
  });
});
