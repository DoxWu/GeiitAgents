import { createHash, webcrypto } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, expect, it, vi } from 'vitest';
import type { VaultData } from '@/types/workbench';
import { PrivateVault } from '../privateVault';
import { exportVaultBackup, importVaultBackup } from '../vaultBackup';
import { workImageFromDataUrl } from '../workbenchImages';
import { decodeBase64, encodeBase64 } from '../binaryBase64';

afterEach(() => vi.unstubAllGlobals());

it('preserves a 25 MB generated image across encryption, unlock and backup restore', async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('Blob', NodeBlob);
  const bytes = new Uint8Array(25_000_000);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); bytes[bytes.length - 1] = 173;
  const expected = createHash('sha256').update(bytes).digest('hex');
  const image = workImageFromDataUrl(`data:image/png;base64,${encodeBase64(bytes)}`, '4k.png');
  const data: VaultData = { profiles: [], conversations: [], imageTasks: [{ id: '4k', name: '4K', updatedAt: new Date().toISOString(), draft: {
    canvas: { width: 3840, height: 2160, background: '#ffffff' }, prompt: 'synthetic 4K', shapes: [], references: [], result: image,
  } }] };
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const vault = new PrivateVault(storage, 'large');
  await vault.unlock('synthetic'); await vault.save(data); vault.lock();
  expect(values.get('large')).not.toContain('synthetic 4K');
  const reopened = new PrivateVault(storage, 'large');
  const loaded = await reopened.unlock('synthetic'); reopened.lock();
  const { file } = await exportVaultBackup(loaded, 'synthetic');
  expect(file.size).toBeGreaterThan(24 * 1024 * 1024);
  const restored = (await importVaultBackup(file, 'synthetic')).data.imageTasks![0].draft.result!;
  expect(restored.bytes).toBe(bytes.length);
  expect(createHash('sha256').update(decodeBase64(restored.dataUrl.split(',')[1])).digest('hex')).toBe(expected);
}, 60000);
