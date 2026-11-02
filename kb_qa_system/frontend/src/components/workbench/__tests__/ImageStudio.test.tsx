import { webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWorkbenchStore as store } from '@/store/workbenchStore';
import type { WorkImage } from '@/types/workbench';
import { ImageStudio } from '../ImageStudio';

vi.mock('@/services/workbenchModel', async original => ({ ...await original<typeof import('@/services/workbenchModel')>(), getAccountModel: vi.fn().mockResolvedValue(null) }));
const image: WorkImage = { name: 'synthetic.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', bytes: 8 };
vi.mock('../ImageGenerator', () => ({ ImageGenerator: ({ onImage }: { onImage: (image: WorkImage) => void }) => <button onClick={() => onImage(image)}>Return generated fixture</button> }));
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto); localStorage.clear(); await store.getState().unlock('synthetic-image-password');
  await store.getState().saveImageTask({ id: 'saved-task', name: 'Saved task', updatedAt: new Date().toISOString(), draft: { prompt: 'existing prompt', references: [], shapes: [] } });
});
afterEach(async () => { cleanup(); await store.getState().lock(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('accepts a generated result on a freshly reopened task without any editor change', () => {
  render(<ImageStudio />);
  fireEvent.click(screen.getByRole('button', { name: 'Return generated fixture' }));
  expect(screen.getByRole('img', { name: '模型生成结果' }).getAttribute('src')).toBe(image.dataUrl);
});
