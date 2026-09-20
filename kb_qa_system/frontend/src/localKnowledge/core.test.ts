import { describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE, fingerprint, rank, splitText, validateProfile, validateVector, type LocalIndex } from './core';
describe('local embedding contract', () => {
  it('counts E5 prefix and special tokens without losing Unicode or source offsets', () => {
    const profile = { ...DEFAULT_PROFILE, maxTokens: 32 };
    const source = ('中文🙂 Employee reimbursement\n').repeat(70);
    const count = (text: string) => Array.from(text).length + 2;
    const chunks = splitText(source, profile, count);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map(c => c.text).join('')).toBe(source);
    for (const chunk of chunks) {
      expect(chunk.text).toBe(source.slice(chunk.start, chunk.end));
      expect(count(profile.passagePrefix + chunk.text)).toBeLessThanOrEqual(32);
      expect(chunk.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
    }
  });
  it('rejects a prefix leaving no token budget', () => {
    expect(() => splitText('a', { ...DEFAULT_PROFILE, maxTokens: 16, passagePrefix: 'x'.repeat(20) }, t => t.length)).toThrow('token');
  });
  it.each(['revision', 'sha256', 'pooling', 'normalize', 'dimensions', 'repo', 'dtype'])('rejects invalid %s', field => {
    expect(() => validateProfile({ ...DEFAULT_PROFILE, [field]: 'invalid' })).toThrow();
  });
  it('fingerprints preprocessing, version and runtime, independent of JSON key order', () => {
    expect(fingerprint({ ...DEFAULT_PROFILE, queryPrefix: '' })).not.toBe(fingerprint(DEFAULT_PROFILE));
    expect(fingerprint({ ...DEFAULT_PROFILE, pooling: 'cls' })).not.toBe(fingerprint(DEFAULT_PROFILE));
    expect(fingerprint(Object.fromEntries(Object.entries(DEFAULT_PROFILE).reverse()) as typeof DEFAULT_PROFILE)).toBe(fingerprint(DEFAULT_PROFILE));
  });
  it('rejects dimension mismatch, non-finite values and zero output', () => {
    expect(() => validateVector([1], 2)).toThrow();
    expect(() => validateVector([NaN, 1], 2)).toThrow();
    expect(() => validateVector([0, 0], 2)).toThrow();
    expect(validateVector([3, 4], 2)).toEqual([0.6, 0.8]);
  });
  it('ranks matching source vectors and refuses another model even at same dimension', () => {
    const profile = { ...DEFAULT_PROFILE, dimensions: 2 };
    const index: LocalIndex = { version: 1, revision: 'test', updatedAt: '', profile, fingerprint: fingerprint(profile),
      documents: [{ id: 'd1', name: 'policy.md', text: 'abc', bytes: 3 }],
      chunks: [{ documentId: 'd1', start: 0, end: 1, text: 'a', vector: [1, 0] }, { documentId: 'd1', start: 1, end: 3, text: 'bc', vector: [0, 1] }] };
    expect(rank(index, profile, [1, 0])[0]).toMatchObject({ name: 'policy.md', text: 'a', score: 1 });
    expect(() => rank(index, { ...profile, passagePrefix: '' }, [1, 0])).toThrow('不匹配');
  });
});
