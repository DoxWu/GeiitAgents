import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useWorkbenchStore } from '@/store/workbenchStore';
import { ImageGenerator } from '../ImageGenerator';
import type { WorkImage } from '@/types/workbench';

vi.mock('@/api/serverImages', () => ({ listServerImageModels: vi.fn().mockResolvedValue([]) }));
const capture = () => () => true;
vi.mock('@/hooks/useWorkbenchFence', () => ({ useWorkbenchFence: () => capture }));
const reference: WorkImage = { name: 'first.png', mimeType: 'image/png', bytes: 8, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' };
const initial = useWorkbenchStore.getState();
afterEach(() => { cleanup(); useWorkbenchStore.setState(initial); vi.restoreAllMocks(); });

it('revokes consent and cancels old generation when reference images change', async () => {
  let resolve!: (image: WorkImage) => void;
  const generate = vi.fn<typeof initial.generateImage>(() => new Promise<WorkImage>(done => { resolve = done; }));
  useWorkbenchStore.setState({ unlocked: true, profiles: [{ id: 'direct', name: 'direct', mode: 'direct', baseUrl: 'https://models.example/v1', model: 'chat', imageModel: 'edit', hasKey: true }], generateImage: generate });
  const onImage = vi.fn();
  const view = render(<ImageGenerator contextKey="task" requestPrompt="edit" referenceImages={[reference]} onImage={onImage} />);
  fireEvent.click(screen.getByText('由模型生成图片'));
  const consent = screen.getByRole('checkbox'); fireEvent.click(consent);
  fireEvent.click(screen.getByRole('button', { name: '生成图片并放入设计' }));
  expect(generate.mock.calls[0]?.[1]).toBe('edit');
  expect(generate.mock.calls[0]?.[5]).toEqual([reference]);
  const signal = (generate.mock.calls as unknown[][])[0][3] as AbortSignal;
  view.rerender(<ImageGenerator contextKey="task" requestPrompt="edit" referenceImages={[reference, { ...reference, name: 'second.png' }]} onImage={onImage} />);
  await waitFor(() => expect(signal.aborted).toBe(true));
  expect((consent as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole('button', { name: '生成图片并放入设计' }) as HTMLButtonElement).disabled).toBe(true);
  resolve(reference); await waitFor(() => expect(onImage).not.toHaveBeenCalled());
  expect(screen.getByText(/直接发送2张参考原图/)).toBeTruthy();
});

it('cancels an in-flight output and revokes cloud consent when the format changes', async () => {
  let resolve!: (image: WorkImage) => void;
  const generate = vi.fn<typeof initial.generateImage>(() => new Promise(done => { resolve = done; }));
  useWorkbenchStore.setState({ unlocked: true, profiles: [{ id: 'direct', name: 'direct', mode: 'direct', baseUrl: 'https://models.example/v1', model: 'chat', imageModel: 'gpt-image-2.6-flare', hasKey: true }], generateImage: generate });
  const onImage = vi.fn();
  const view = render(<ImageGenerator contextKey="task" requestPrompt="subject" output={{ format: 'svg' }} onImage={onImage} />);
  fireEvent.click(screen.getByText('由模型生成图片')); fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: '生成图片并放入设计' }));
  const signal = generate.mock.calls[0][3]!;
  view.rerender(<ImageGenerator contextKey="task" requestPrompt="subject" output={{ format: 'gif', frameCount: 12 }} onImage={onImage} />);
  expect(signal.aborted).toBe(true); expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  resolve(reference); await waitFor(() => expect(onImage).not.toHaveBeenCalled());
});
