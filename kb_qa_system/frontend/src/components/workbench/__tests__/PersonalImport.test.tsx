import { Blob } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { PersonalImport } from '../PersonalImport';
import { PersonalItems } from '../PersonalItems';
import { useWorkbenchStore as store } from '@/store/workbenchStore';
import { exportPersonalItems, type PersonalItem } from '@/personal/items';
import { personalDraft } from '@/personal/itemDraft';

const password = 'import-ui-fixture', now = '2026-09-29T10:00:00.000Z';
function note(i = 0): PersonalItem { return { kind: 'note', title: '导入笔记 ' + i, content: '<script>alert(1)</script>', tags: [], id: crypto.randomUUID(), revision: 1, createdAt: now, updatedAt: now, completedAt: null }; }
const button = (name: string) => screen.getByRole('button', { name });
const click = (name: string) => fireEvent.click(button(name));
async function upload(value: string) {
  const file = new Blob([value]); Object.assign(file, { name: 'test.json' });
  fireEvent.change(screen.getByLabelText('笔记待办导入文件'), { target: { files: [file] } });
  await screen.findByRole('region', { name: '笔记待办导入预检查' });
}
const acknowledge = () => fireEvent.click(screen.getByLabelText('我已核对所选条目及替换内容，确认写入本机加密库'));
beforeEach(async () => { vi.stubGlobal('crypto', webcrypto); localStorage.clear(); await store.getState().unlock(password); });
afterEach(async () => { cleanup(); vi.restoreAllMocks(); await store.getState().lock(); vi.unstubAllGlobals(); });

it('requires explicit confirmation, retains selections across pages, and clears acknowledgement after action changes', async () => {
  render(<PersonalImport onBack={vi.fn()} />); const items = Array.from({ length: 21 }, (_, i) => note(i));
  await upload(exportPersonalItems(items, 'json')); expect(button('确认导入所选条目')).toBeDisabled();
  fireEvent.change(screen.getByLabelText('导入处理方式 1'), { target: { value: 'skip' } }); acknowledge();
  click('下一页导入条目'); expect(screen.getByLabelText('导入处理方式 21')).toHaveValue('add');
  fireEvent.change(screen.getByLabelText('导入处理方式 21'), { target: { value: 'skip' } }); expect(button('确认导入所选条目')).toBeDisabled();
  click('上一页导入条目'); expect(screen.getByLabelText('导入处理方式 1')).toHaveValue('skip');
  expect(document.querySelector('script')).toBeNull(); acknowledge(); click('确认导入所选条目');
  await screen.findByText('导入已加密保存'); expect(store.getState().personalItems).toHaveLength(19);
});
it('compares conflicts and retries failed persistence without repeating the replacement', async () => {
  const local = note(); store.setState({ personalItems: [local] }); render(<PersonalImport onBack={vi.fn()} />);
  await upload(exportPersonalItems([{ ...local, content: '文件中的新正文' }], 'json'));
  expect(screen.getByLabelText('导入处理方式 1')).toHaveValue('skip');
  fireEvent.change(screen.getByLabelText('导入处理方式 1'), { target: { value: 'replace' } }); acknowledge();
  const failure = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); }); click('确认导入所选条目');
  await screen.findByText('导入结果已在内存，尚未确认持久保存');
  await waitFor(() => expect(button('重试保存导入结果')).toBeEnabled()); expect(screen.getByLabelText('笔记待办导入文件')).toBeDisabled();
  failure.mockRestore(); click('重试保存导入结果'); await screen.findByText('导入已加密保存');
  expect(store.getState().personalItems).toEqual([{ ...local, revision: 2, content: '文件中的新正文', updatedAt: expect.any(String) }]);
});
it('previews and applies an explicitly selected field merge without replacing unselected local values', async () => {
  const local = note(); store.setState({ personalItems: [local] }); render(<PersonalImport onBack={vi.fn()} />);
  await upload(exportPersonalItems([{ ...local, title: '文件标题', content: '文件正文', tags: ['导入'] }], 'json'));
  fireEvent.change(screen.getByLabelText('导入处理方式 1'), { target: { value: 'merge' } });
  const confirm = button('确认导入所选条目'); expect(confirm).toBeDisabled();
  fireEvent.click(screen.getByLabelText('采用文件中的标题'));
  acknowledge(); expect(confirm).toBeEnabled(); click('确认导入所选条目');
  await screen.findByText('导入已加密保存');
  expect(store.getState().personalItems[0]).toMatchObject({ id: local.id, revision: 2, title: '文件标题', content: local.content, tags: local.tags, createdAt: local.createdAt });
});
it('shows raw draft time zone and incomplete values, and cancels on unmount', async () => {
  const d = personalDraft(); d.input.title = ''; d.dueText = 'incomplete'; d.timezone = 'Asia/Shanghai';
  const view = render(<PersonalImport onBack={vi.fn()} />); await upload(JSON.stringify(d));
  expect(screen.getByText(/原始截止输入：incomplete/)).toBeInTheDocument();
  expect(screen.getByLabelText('导入处理方式 1')).toHaveValue('copy');
  view.unmount(); expect(store.getState().personalImportPreview).toBeNull(); expect(store.getState().personalDrafts).toEqual([]);
});
it('opens the import screen from the actual personal items page without dropping an unfinished editor', async () => {
  render(<PersonalItems />); fireEvent.change(screen.getByLabelText('标题'), { target: { value: '未保存的编辑' } });
  click('导入 JSON'); await screen.findByRole('region', { name: '导入笔记与待办 JSON' });
  await act(async () => { await store.getState().flushPersonalDrafts(); });
  click('返回本机记录'); expect(screen.getByLabelText('标题')).toHaveValue('未保存的编辑');
});
