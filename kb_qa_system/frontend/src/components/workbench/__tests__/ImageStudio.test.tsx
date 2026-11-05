import { webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWorkbenchStore as store } from '@/store/workbenchStore';
import type { WorkImage } from '@/types/workbench';
import { ImageStudio } from '../ImageStudio';
import * as images from '@/services/workbenchImages';

vi.mock('@/services/workbenchModel', async original => ({ ...await original<typeof import('@/services/workbenchModel')>(), getAccountModel: vi.fn().mockResolvedValue(null) }));
const image: WorkImage = { name: 'synthetic.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', bytes: 8 };
vi.mock('../ImageGenerator', () => ({ ImageGenerator: ({ onImage, requestPrompt }: { onImage: (image: WorkImage) => void; requestPrompt?: string }) => <><div data-testid="sent-prompt">{requestPrompt}</div><button onClick={() => onImage(image)}>Return generated fixture</button></> }));
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

it('starts a file download from the result button and reports initiation', () => {
  const download = vi.spyOn(images, 'downloadGeneratedWorkImage').mockImplementation(() => {});
  render(<ImageStudio />);
  fireEvent.click(screen.getByRole('button', { name: 'Return generated fixture' }));
  fireEvent.click(screen.getByRole('button', { name: '下载图片' }));
  expect(download).toHaveBeenCalledWith(image);
  expect(screen.getByRole('status').textContent).toBe('图片下载已开始。');
});

it('shows a retry message if the download cannot be initiated', () => {
  vi.spyOn(images, 'downloadGeneratedWorkImage').mockImplementation(() => { throw new Error('synthetic failure'); });
  render(<ImageStudio />);
  fireEvent.click(screen.getByRole('button', { name: 'Return generated fixture' }));
  fireEvent.click(screen.getByRole('button', { name: '下载图片' }));
  expect(screen.getByRole('status').textContent).toContain('图片下载失败');
});

it('sends the user-edited full request prompt to the image generator', () => {
  render(<ImageStudio />);
  fireEvent.click(screen.getByText('实际发送的生图提示词（含当前构图）'));
  const editor = screen.getByRole('textbox', { name: '实际发送的生图提示词' });
  fireEvent.change(editor, { target: { value: 'user-authored final image instructions' } });
  expect(screen.getByTestId('sent-prompt').textContent).toBe('user-authored final image instructions');
  expect((editor as HTMLTextAreaElement).value).toBe('user-authored final image instructions');
});

it('keeps number edits local until valid and switches format settings without duplicating controls', async () => {
  render(<ImageStudio />);
  fireEvent.change(screen.getByLabelText('生成格式'), { target: { value: 'gif' } });
  const count = screen.getByLabelText('动画帧数');
  fireEvent.change(count, { target: { value: '' } }); fireEvent.blur(count);
  expect((count as HTMLInputElement).value).toBe('9');
  fireEvent.change(count, { target: { value: '12' } }); fireEvent.blur(count);
  expect(screen.getByTestId('sent-prompt').textContent).toContain('12帧');
  fireEvent.click(screen.getByRole('button', { name: '新建图片任务' }));
  await waitFor(() => expect((screen.getByLabelText('生成格式') as HTMLSelectElement).value).toBe('png'));
  expect(screen.getAllByLabelText('生成格式')).toHaveLength(1);
});
