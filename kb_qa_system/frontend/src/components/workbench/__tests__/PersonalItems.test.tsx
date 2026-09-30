import { webcrypto } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PersonalItems } from '../PersonalItems';
import { useWorkbenchStore as store } from '@/store/workbenchStore';
import { PrivateVault } from '@/services/privateVault';
import { personalDraft } from '@/personal/itemDraft';

vi.mock('../ServerReminders', () => ({ ServerReminders: () => <p>提醒列表</p> }));
const password = 'personal-ui-fixture';
const note = { kind: 'note' as const, title: '评审笔记', content: '正式内容', tags: [] };
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const title = () => screen.getByLabelText('标题');
beforeEach(async () => { vi.stubGlobal('crypto', webcrypto); localStorage.clear(); await store.getState().unlock(password); });
afterEach(async () => { cleanup(); vi.restoreAllMocks(); await store.getState().lock(); vi.unstubAllGlobals(); });

it('keeps independent incomplete edits through tab changes, module unmount and lock', async () => {
  render(<PersonalItems />);
  fireEvent.change(title(), { target: { value: '待办草稿' } });
  click('笔记'); fireEvent.change(screen.getByLabelText('笔记或待办内容'), { target: { value: '没有标题的未完成笔记' } });
  click('待办'); expect(title()).toHaveValue('待办草稿');
  click('邮件提醒'); await screen.findByText('提醒列表'); click('本机记录');
  expect(screen.getByLabelText('笔记或待办内容')).toHaveValue('没有标题的未完成笔记');
  cleanup(); await act(async () => { await store.getState().lock(); await store.getState().unlock(password); });
  render(<PersonalItems />); expect(title()).toHaveValue('');
  expect(screen.getByLabelText('笔记或待办内容')).toHaveValue('没有标题的未完成笔记');
  click('待办'); expect(title()).toHaveValue('待办草稿');
});

it('reconciles a failed final write and retries persistence without a duplicate record', async () => {
  render(<PersonalItems />); fireEvent.change(title(), { target: { value: '只保存一次' } });
  const realSave = PrivateVault.prototype.save;
  const failure = vi.spyOn(PrivateVault.prototype, 'save').mockImplementation(function (this: PrivateVault, data) {
    return data.personalItems?.length ? Promise.reject(new Error('quota')) : realSave.call(this, data);
  });
  click('保存记录');
  await waitFor(() => expect(store.getState().storageError).toBeTruthy());
  await waitFor(() => expect(screen.getByRole('button', { name: '重试本机保存' })).toBeEnabled());
  expect(screen.getByRole('button', { name: '保存记录' })).toBeDisabled();
  expect(screen.getByText(/当前内存记录尚未确认保存/)).toBeInTheDocument();
  failure.mockRestore(); click('重试本机保存'); await screen.findByText('本机记录和草稿已重新保存。');
  expect(store.getState().personalItems).toHaveLength(1); expect(store.getState().personalItems[0].revision).toBe(1);
  expect(title()).toHaveValue('只保存一次'); expect(store.getState().personalDrafts).toEqual([]);
});

it('refuses dirty batch archive, resets filtered selections, and restores archived content', async () => {
  await store.getState().savePersonalItem(crypto.randomUUID(), note, 0);
  render(<PersonalItems />); click('笔记'); click(note.title);
  fireEvent.change(title(), { target: { value: '编辑中' } });
  fireEvent.click(screen.getByLabelText('选择记录：' + note.title)); click('归档所选');
  await screen.findByText('所选记录有未保存草稿，请先保存或丢弃草稿。');
  expect(store.getState().personalItems[0].archivedAt).toBeFalsy();
  vi.spyOn(window, 'confirm').mockReturnValue(true); click('丢弃草稿并载入最新记录');
  await waitFor(() => expect(title()).toHaveValue(note.title));
  fireEvent.change(screen.getByLabelText('搜索笔记和待办'), { target: { value: '评审' } });
  expect(screen.getByRole('button', { name: '归档所选' })).toBeDisabled();
  click('选中筛选结果'); click('归档所选'); await screen.findByText('所选记录已归档。');
  expect(title()).toBeDisabled(); expect(screen.getByText('没有匹配记录')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('归档筛选'), { target: { value: 'archived' } });
  expect(screen.getByLabelText('选择记录：' + note.title)).toBeInTheDocument();
  click('恢复记录'); await screen.findByText('所选记录已恢复。');
  expect(title()).toBeEnabled(); expect(store.getState().personalItems[0]).toMatchObject({ content: '正式内容', revision: 3 });
});

it('keeps conflicting text and its original draft when copied to a new record', async () => {
  const item = await store.getState().savePersonalItem(crypto.randomUUID(), note, 0);
  render(<PersonalItems />); click('笔记'); click(note.title);
  fireEvent.change(screen.getByLabelText('笔记或待办内容'), { target: { value: '冲突中的输入' } });
  await act(async () => { await store.getState().savePersonalItem(item.id, { ...note, content: '其他窗口的修改' }, 1); });
  expect(screen.getByRole('button', { name: '保存记录' })).toBeDisabled();
  click('另存为新草稿'); await screen.findByText('已复制为新草稿。原草稿仍保留，确认保存后可自行丢弃。');
  expect(screen.getByLabelText('笔记或待办内容')).toHaveValue('冲突中的输入');
  click('保存记录'); await screen.findByText('已保存到本机加密库。');
  expect(store.getState().personalItems).toHaveLength(2);
  expect(store.getState().personalItems.find(value => value.id === item.id)?.content).toBe('其他窗口的修改');
  expect(store.getState().personalDrafts).toHaveLength(1);
  expect(store.getState().personalDrafts[0].input.content).toBe('冲突中的输入');
});

it('aligns the editor revision after an archive restore write failure and storage retry', async () => {
  const item = await store.getState().savePersonalItem(crypto.randomUUID(), note, 0);
  await store.getState().archivePersonalItems([{ id: item.id, revision: 1 }], true);
  render(<PersonalItems />); click('笔记');
  fireEvent.change(screen.getByLabelText('归档筛选'), { target: { value: 'archived' } }); click(note.title + '已归档 ·');
  const failure = vi.spyOn(PrivateVault.prototype, 'save').mockRejectedValue(new Error('quota'));
  click('恢复记录'); await waitFor(() => expect(store.getState().storageError).toBeTruthy());
  await waitFor(() => expect(screen.getByRole('button', { name: '重试本机保存' })).toBeEnabled());
  failure.mockRestore(); click('重试本机保存'); await screen.findByText('本机记录和草稿已重新保存。');
  fireEvent.change(title(), { target: { value: '恢复后继续编辑' } });
  expect(screen.getByRole('button', { name: '保存记录' })).toBeEnabled(); click('保存记录');
  await screen.findByText('已保存到本机加密库。');
  expect(store.getState().personalItems[0]).toMatchObject({ revision: 4, title: '恢复后继续编辑' });
});

it('prevents starting unstorable edits at capacity while existing drafts remain editable', async () => {
  const drafts = Array.from({ length: 100 }, () => personalDraft());
  store.setState({ personalDrafts: drafts }); render(<PersonalItems />);
  expect(title()).toBeEnabled(); click('新建待办');
  expect(title()).toBeDisabled(); expect(screen.getByText(/已达到 100 条草稿上限/)).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole('button', { name: '恢复草稿：未命名' })[0]);
  expect(title()).toBeEnabled(); expect(store.getState().personalDrafts).toHaveLength(100);
});

it('imports Markdown as a new note draft and preserves existing notes and drafts', async () => {
  await store.getState().savePersonalItem(crypto.randomUUID(), note, 0);
  render(<PersonalItems />); click('笔记');
  fireEvent.change(title(), { target: { value: 'Existing draft' } });
  fireEvent.change(screen.getByLabelText('笔记或待办内容'), { target: { value: 'Keep this draft.' } });
  const existingDraftId = store.getState().personalDrafts[0].id;
  const file = new File(['# Imported note\n\nSource text.'], 'Imported note.md', { type: 'text/markdown' });
  fireEvent.change(screen.getByLabelText('Markdown 笔记文件'), { target: { files: [file] } });
  await waitFor(() => expect(title()).toHaveValue('Imported note'));
  expect(screen.getByLabelText('笔记或待办内容')).toHaveValue('# Imported note\n\nSource text.');
  expect(store.getState().personalItems).toHaveLength(1);
  expect(store.getState().personalDrafts).toHaveLength(2);
  expect(store.getState().personalDrafts.some(value => value.id === existingDraftId && value.input.content === 'Keep this draft.')).toBe(true);
  expect(screen.getByText('Markdown 已作为独立笔记草稿导入；确认保存后写入本机加密库。')).toBeInTheDocument();
});

it('keeps the active draft untouched when a Markdown file is rejected', async () => {
  render(<PersonalItems />); click('笔记');
  fireEvent.change(screen.getByLabelText('Markdown 笔记文件'), { target: { files: [new File(['bad'], 'notes.txt')] } });
  await screen.findByText('请选择 .md 或 .markdown 文件。');
  expect(title()).toHaveValue(''); expect(store.getState().personalDrafts).toHaveLength(0);
});
