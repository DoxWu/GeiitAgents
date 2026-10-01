import { webcrypto } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileTextBatch } from '../FileTextBatch';
import { MemoryDirectory } from '@/fileOrganizer/testDirectory';
import { useWorkbenchStore as store } from '@/store/workbenchStore';

let directory: MemoryDirectory;
const button = (name: string) => screen.getByRole('button', { name });
const click = (name: string) => fireEvent.click(button(name));
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto); localStorage.clear(); await store.getState().unlock('batch-ui-fixture');
  directory = new MemoryDirectory({ 'a.md': 'old\r\n', 'b.txt': 'old\n', 'skip.json': '{}' }); window.showDirectoryPicker = vi.fn().mockResolvedValue(directory);
});
afterEach(async () => { cleanup(); vi.restoreAllMocks(); await store.getState().lock(); delete window.showDirectoryPicker; vi.unstubAllGlobals(); });
async function open() {
  click('选择批量编辑目录'); await screen.findByLabelText('批量选择文件：a.md'); fireEvent.click(screen.getByLabelText('批量选择文件：a.md')); fireEvent.click(screen.getByLabelText('批量选择文件：b.txt'));
  fireEvent.change(screen.getByLabelText('批量查找内容'), { target: { value: 'old' } }); fireEvent.change(screen.getByLabelText('批量替换内容（可为空）'), { target: { value: 'new' } });
  click('读取并预览批次'); await screen.findByRole('region', { name: '批量文本预览' });
}
it('supports an ordered second replacement rule in the preview', async () => {
  render(<FileTextBatch />); click('选择批量编辑目录'); await screen.findByLabelText('批量选择文件：a.md'); fireEvent.click(screen.getByLabelText('批量选择文件：a.md'));
  fireEvent.change(screen.getByLabelText('批量查找内容'), { target: { value: 'old' } }); fireEvent.change(screen.getByLabelText('批量替换内容（可为空）'), { target: { value: 'Alice' } });
  click('增加替换规则（1/5）'); fireEvent.change(screen.getByLabelText('批量查找内容 2'), { target: { value: 'Alice' } }); fireEvent.change(screen.getByLabelText('批量替换内容（可为空） 2'), { target: { value: 'review' } });
  click('读取并预览批次'); await screen.findByRole('region', { name: '批量文本预览' }); expect(screen.getByLabelText('批次完整写入版本')).toHaveValue('review\n');
});
it('requires directory and batch confirmation, resets confirmation on selection and previews exact bytes', async () => {
  render(<FileTextBatch />); await open(); expect(screen.queryByLabelText('批量选择文件：skip.json')).not.toBeInTheDocument();
  expect(screen.getByLabelText('批次完整写入版本')).toHaveValue('new\n'); expect(button('确认写入批次')).toBeDisabled();
  fireEvent.click(screen.getByLabelText(/我已检查所选文件差异/)); expect(button('确认写入批次')).toBeDisabled();
  fireEvent.click(screen.getByLabelText(/我确认批量编辑/)); fireEvent.click(screen.getByLabelText(/我已检查所选文件差异/));
  fireEvent.click(screen.getByLabelText('应用批次变更：b.txt')); expect(button('确认写入批次')).toBeDisabled();
  fireEvent.click(screen.getByLabelText(/我已检查所选文件差异/)); click('确认写入批次'); await screen.findByText('所选文件已全部写入并校验，版本已加密保存。');
  expect(await directory.files.get('a.md')!.text()).toBe('new\r\n'); expect(await directory.files.get('b.txt')!.text()).toBe('old\n');
});
it('invalidates preview on rule changes and clears it on unmount', async () => {
  const view = render(<FileTextBatch />); await open();
  fireEvent.change(screen.getByLabelText('批量替换内容（可为空）'), { target: { value: '' } }); expect(screen.queryByRole('region', { name: '批量文本预览' })).not.toBeInTheDocument();
  click('读取并预览批次'); await screen.findByRole('region', { name: '批量文本预览' }); view.unmount(); expect(store.getState().textBatchPreview).toBeNull(); expect(directory.closes).toBe(0);
});
it('shows partial history on failure and only retries saving records', async () => {
  render(<FileTextBatch />); await open(); fireEvent.click(screen.getByLabelText(/我确认批量编辑/)); fireEvent.click(screen.getByLabelText(/我已检查所选文件差异/));
  const original = localStorage.setItem.bind(localStorage); let failed = false;
  vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => { if (failed) throw new Error('quota'); original(key, value); }); directory.onClose = () => { failed = true; };
  click('确认写入批次'); await waitFor(() => expect(button('重试批次记录保存')).toBeEnabled()); expect(directory.closes).toBe(1);
  failed = false; click('重试批次记录保存'); await waitFor(() => expect(store.getState().storageError).toBeNull()); expect(directory.closes).toBe(1);
  await userEvent.click(screen.getByText(/fixture-directory · 2\/2/));
  expect(await screen.findByText(/b.txt · 未执行/)).toBeInTheDocument();
});
