import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { pickOrganizerDirectory } from './directory';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
beforeEach(() => { vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('__TAURI_INTERNALS__', {}); invoke.mockReset(); });
afterEach(() => vi.unstubAllGlobals());
it('uses the native picker, retains only opaque grants and does no whole-file IPC', async () => {
  invoke.mockImplementation(async (command, args) => {
    if (command === 'organizer_pick_directory') return { token: 'grant', name: 'fixture', identity: 'directory-id' };
    if (args?.operation?.op === 'stat') return { size: 100, modifiedAt: 200, identity: 'file-id' };
    if (args?.operation?.op === 'hash') return 'a'.repeat(64);
  });
  const directory = await pickOrganizerDirectory(), file = await directory.getFileHandle('a.txt');
  const metadata = await file.getFile(); expect(metadata.size).toBe(100);
  await expect(metadata.arrayBuffer()).rejects.toThrow('受限文件');
  expect(await file.fingerprint?.()).toBe('a'.repeat(64));
  await file.copyFrom?.(file); await file.removeIfMatches?.('a'.repeat(64));
  expect(invoke).toHaveBeenCalledWith('organizer_access', { operation: expect.objectContaining({ op: 'copy', token: 'grant', name: 'a.txt', source_token: 'grant', source_identity: 'file-id' }) });
  directory.retain?.(); directory.release?.();
  expect(invoke).not.toHaveBeenCalledWith('organizer_release_directory', expect.anything());
  directory.release?.(); expect(invoke).toHaveBeenCalledWith('organizer_release_directory', { token: 'grant' });
});
it('preserves missing-file and cancelled-picker distinctions', async () => {
  invoke.mockResolvedValueOnce(null);
  await expect(pickOrganizerDirectory()).rejects.toMatchObject({ name: 'AbortError' });
  invoke.mockResolvedValueOnce({ token: 'grant', name: 'fixture', identity: 'id' });
  const directory = await pickOrganizerDirectory(); invoke.mockRejectedValueOnce('NotFoundError');
  await expect(directory.getFileHandle('gone.txt')).rejects.toMatchObject({ name: 'NotFoundError' });
  await expect(directory.removeEntry('any.txt')).rejects.toThrow('必须同时校验');
});
