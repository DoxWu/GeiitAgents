import { webcrypto } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileTextEditor } from '../FileTextEditor';
import { MemoryDirectory } from '@/fileOrganizer/testDirectory';
import { useWorkbenchStore as store } from '@/store/workbenchStore';

let directory: MemoryDirectory;
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto); localStorage.clear(); await store.getState().unlock('text-editor-fixture');
  directory = new MemoryDirectory({ 'a.md': '# original\r\n', 'skip.json': '{}' });
  window.showDirectoryPicker = vi.fn().mockResolvedValue(directory); vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(async () => { cleanup(); vi.restoreAllMocks(); await store.getState().lock(); delete window.showDirectoryPicker; vi.unstubAllGlobals(); });
async function open() {
  const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: '选择文本编辑目录' }));
  await user.selectOptions(screen.getByLabelText('目录中的文本文件'), 'a.md');
  await user.click(screen.getByRole('button', { name: '读取并编辑' })); await screen.findByLabelText('文本编辑内容');
  return user;
}
it('requires preview and directory acknowledgement; changing input invalidates the preview', async () => {
  render(<FileTextEditor />); const user = await open();
  expect(screen.queryByRole('option', { name: 'skip.json' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '确认写入所选文件' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('文本编辑内容'), { target: { value: '# edited\n' } });
  await user.click(screen.getByRole('button', { name: '预览文本差异' }));
  expect(screen.getByRole('button', { name: '确认写入所选文件' })).toBeDisabled();
  await user.click(screen.getByRole('checkbox')); expect(screen.getByRole('button', { name: '确认写入所选文件' })).toBeEnabled();
  fireEvent.change(screen.getByLabelText('文本编辑内容'), { target: { value: '# final\n' } });
  expect(screen.queryByRole('region', { name: '文本差异预览' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '预览文本差异' })); await user.click(screen.getByRole('button', { name: '确认写入所选文件' }));
  await screen.findByText('文件已写入并校验，前后版本已加密保存。');
  expect(await directory.files.get('a.md')!.text()).toBe('# final\r\n');
});
it('keeps drafts across unmount but requires new directory selection before writing', async () => {
  const release = vi.fn(); Object.assign(directory, { release });
  const first = render(<FileTextEditor />); const user = await open();
  fireEvent.change(screen.getByLabelText('文本编辑内容'), { target: { value: 'retained draft' } });
  first.unmount(); expect(release).toHaveBeenCalledTimes(2); // read operation and component each release their own reference
  render(<FileTextEditor />); expect(screen.getByLabelText('文本编辑内容')).toHaveValue('retained draft');
  await user.click(screen.getByRole('button', { name: '预览文本差异' }));
  expect(screen.getByRole('button', { name: '确认写入所选文件' })).toBeDisabled();
  expect(screen.getByLabelText('目录中的文本文件')).toBeDisabled();
});
it('preserves an external edit and shows the conflict while keeping the draft available for export', async () => {
  render(<FileTextEditor />); const user = await open();
  fireEvent.change(screen.getByLabelText('文本编辑内容'), { target: { value: 'draft' } });
  await user.click(screen.getByRole('checkbox')); await user.click(screen.getByRole('button', { name: '预览文本差异' }));
  directory.put('a.md', 'external'); await user.click(screen.getByRole('button', { name: '确认写入所选文件' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('外部修改'));
  expect(screen.getByLabelText('文本编辑内容')).toHaveValue('draft'); expect(directory.closes).toBe(0);
});
it('releases a picker result when the editor closes while the picker is open', async () => {
  let resolve!: (value: MemoryDirectory) => void;
  window.showDirectoryPicker = vi.fn(() => new Promise<MemoryDirectory>(done => { resolve = done; })); const release = vi.fn(); Object.assign(directory, { release });
  const view = render(<FileTextEditor />); await userEvent.click(screen.getByRole('button', { name: '选择文本编辑目录' }));
  view.unmount(); await act(async () => resolve(directory)); expect(release).toHaveBeenCalledOnce();
});
