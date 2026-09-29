import { webcrypto } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FileOrganizer } from '../FileOrganizer';
import { FileTextEditor } from '../FileTextEditor';
import { FileTextBatch } from '../FileTextBatch';
import { useWorkbenchStore as store } from '@/store/workbenchStore';
import { snapshotText, type FileEditVersion } from '@/fileOrganizer/textEdit';
import { MemoryDirectory } from '@/fileOrganizer/testDirectory';
import type { OrganizerRun } from '@/fileOrganizer/history';

let versions: FileEditVersion[], directory: MemoryDirectory;
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto); localStorage.clear(); await store.getState().unlock('history-test-fixture');
  const before = await snapshotText('old'), after = await snapshotText('new');
  versions = Array.from({ length: 21 }, (_, i) => ({ id: 'version-' + String(i).padStart(2, '0'), draftId: 'draft-' + i, name: `file-${i}.md`, directoryName: 'fixture-directory', before, after, status: 'succeeded', createdAt: new Date(Date.UTC(2026, 8, 29, 0, i)).toISOString(), updatedAt: '2026-09-29T01:00:00Z' }));
  directory = new MemoryDirectory(Object.fromEntries(versions.map(v => [v.name, 'new'])));
  window.showDirectoryPicker = vi.fn().mockResolvedValue(directory);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(async () => { cleanup(); vi.restoreAllMocks(); await store.getState().lock(); delete window.showDirectoryPicker; vi.unstubAllGlobals(); });
function history(label: string) { return within(screen.getByRole('region', { name: label })); }
function page(label: string, button: string) { fireEvent.click(within(screen.getByRole('navigation', { name: label + '分页' })).getByRole('button', { name: button })); }
function summaries(label: string) { return screen.getByRole('region', { name: label }).querySelectorAll('summary'); }
async function expand(label: string, index = 0) { await userEvent.click(summaries(label)[index]); }

it('bounds rendered text history and mounts actions only for expanded records', async () => {
  store.setState({ fileEditVersions: versions }); render(<FileTextEditor />);
  expect(summaries('文本版本历史')).toHaveLength(10);
  expect(screen.queryAllByText('导出历史原文（明文）')).toHaveLength(0);
  await expand('文本版本历史'); expect(await screen.findByRole('button', { name: '导出历史原文（明文）' })).toBeVisible();
  page('文本历史', '下一页'); expect(summaries('文本版本历史')[0]).toHaveTextContent('file-10.md');
  expect(screen.queryAllByText('导出历史原文（明文）')).toHaveLength(0);
  page('文本历史', '末页'); expect(summaries('文本版本历史')).toHaveLength(1);
  expect(store.getState().fileEditVersions).toHaveLength(21);
});
it('resets filters to page one and clamps deletion without resurrecting a removed page', async () => {
  store.setState({ fileEditVersions: versions }); render(<FileTextEditor />);
  page('文本历史', '末页'); await expand('文本版本历史');
  fireEvent.click(await screen.findByRole('button', { name: '删除文本记录' }));
  await waitFor(() => expect(history('文本版本历史').getByText(/共 20 条 · 第 2\/2 页/)).toBeVisible());
  expect(store.getState().fileEditVersions.some(v => v.id === 'version-00')).toBe(false);
  act(() => store.setState({ fileEditVersions: [...store.getState().fileEditVersions, { ...versions[0], id: 'inserted' }] }));
  expect(history('文本版本历史').getByText(/共 21 条 · 第 2\/3 页/)).toBeVisible();
  fireEvent.change(screen.getByLabelText('文本历史搜索'), { target: { value: 'file-20' } });
  expect(summaries('文本版本历史')).toHaveLength(1); expect(summaries('文本版本历史')[0]).toHaveTextContent('file-20.md');
  fireEvent.change(screen.getByLabelText('文本历史状态'), { target: { value: 'interrupted' } });
  expect(summaries('文本版本历史')).toHaveLength(0); expect(history('文本版本历史').getByText('没有符合条件的历史记录。')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '清除筛选' })); expect(history('文本版本历史').getByText(/第 1\/3 页/)).toBeVisible();
});
it('uses the chosen record id for restore on a later page and keeps drafts while browsing', async () => {
  store.setState({ fileEditVersions: versions }); render(<FileTextEditor />);
  fireEvent.click(screen.getByRole('button', { name: '选择文本编辑目录' })); await screen.findByRole('option', { name: 'file-0.md' });
  fireEvent.click(screen.getByRole('checkbox')); page('文本历史', '末页'); await expand('文本版本历史');
  fireEvent.click(await screen.findByRole('button', { name: '预览恢复此记录原文' }));
  await screen.findByLabelText('文本编辑内容'); expect(store.getState().fileEditDraft?.restoredFrom).toBe('version-00');
  page('文本历史', '首页'); fireEvent.change(screen.getByLabelText('文本历史搜索'), { target: { value: 'missing' } });
  expect(store.getState().fileEditDraft?.restoredFrom).toBe('version-00'); expect(directory.closes).toBe(0);
});
it('paginates batches without truncating matching members and restores the complete selected batch', async () => {
  const records = versions.slice(0, 12).map((v, i) => ({ ...v, batch: { id: 'batch-' + i, index: 0, total: 1 } }));
  records[0].batch.total = 2; records.push({ ...versions[12], createdAt: records[0].createdAt, status: 'not-started', batch: { id: 'batch-0', index: 1, total: 2 } });
  store.setState({ fileEditVersions: records }); render(<FileTextBatch />);
  expect(summaries('批量文本历史')).toHaveLength(10); page('批次历史', '下一页'); expect(summaries('批量文本历史')).toHaveLength(2);
  fireEvent.change(screen.getByLabelText('批次历史搜索'), { target: { value: 'file-12.md' } });
  fireEvent.change(screen.getByLabelText('批次历史状态'), { target: { value: 'not-started' } });
  expect(summaries('批量文本历史')).toHaveLength(1); expect(summaries('批量文本历史')[0]).toHaveTextContent('2/2 条');
  fireEvent.click(screen.getByRole('button', { name: '选择批量编辑目录' })); await screen.findByLabelText('批量选择文件：file-0.md'); fireEvent.click(screen.getByLabelText(/我确认批量编辑/));
  await expand('批量文本历史'); expect(await screen.findByText(/file-0.md · 已完成/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '预览恢复批次原文' })); await screen.findByRole('region', { name: '批量文本预览' });
  expect(store.getState().textBatchPreview?.rows).toHaveLength(2);
  expect(store.getState().textBatchPreview?.rows.find(r => r.name === 'file-0.md')?.after?.text).toBe('old');
  expect(screen.getByLabelText('应用批次变更：file-12.md')).toBeDisabled(); expect(directory.closes).toBe(0);
});
it('bounds organizer file details while undo still uses all 500 changes', async () => {
  const changes = Array.from({ length: 500 }, (_, i) => ({ source: `a-${i}.txt`, target: `b-${i}.txt`, stage: '.geiit-stage-' + i, size: 3, sha256: 'a'.repeat(64) }));
  const run: OrganizerRun = { id: 'run-old', kind: 'rename', status: 'succeeded', directoryName: 'fixture-directory', changes, createdAt: versions[0].createdAt, updatedAt: versions[0].updatedAt };
  store.setState({ organizerRuns: [run, ...Array.from({ length: 10 }, (_, i) => ({ ...run, id: 'run-' + i, createdAt: versions[i + 1].createdAt, changes: [changes[i]] }))] });
  render(<FileOrganizer />); expect(summaries('整理历史')).toHaveLength(10);
  expect(screen.getByRole('region', { name: '整理历史' }).querySelectorAll('li')).toHaveLength(0);
  page('整理历史', '末页'); await expand('整理历史'); await screen.findByText(/共 500 个/);
  expect(history('整理历史').getAllByRole('listitem')).toHaveLength(50);
  fireEvent.click(screen.getByRole('button', { name: '下一组文件' })); expect(history('整理历史').getAllByRole('listitem')[0]).toHaveTextContent('a-50.txt');
  fireEvent.click(screen.getByRole('button', { name: '选择可整理目录' })); await screen.findByText('当前可写目录：fixture-directory');
  fireEvent.click(screen.getByRole('button', { name: '预览撤销' }));
  expect(within(screen.getByRole('region', { name: '整理计划' })).getAllByRole('row')).toHaveLength(501);
  expect(directory.closes).toBe(0);
});
