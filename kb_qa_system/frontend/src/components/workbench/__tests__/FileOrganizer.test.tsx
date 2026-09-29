import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileOrganizer } from '../FileOrganizer';
import { MemoryDirectory } from '@/fileOrganizer/testDirectory';
import type { OrganizerRun } from '@/fileOrganizer/history';

const { state } = vi.hoisted(() => ({ state: {
  unlocked: true, organizerBusy: false, storageError: null, organizerRuns: [] as OrganizerRun[],
  runFileOrganizer: vi.fn(), inspectOrganizerRun: vi.fn(), cancelFileOrganizer: vi.fn(), removeOrganizerRun: vi.fn(), retryStorage: vi.fn(),
} }));
vi.mock('@/store/workbenchStore', () => ({ useWorkbenchStore: Object.assign(() => state, { getState: () => state }) }));
const record: OrganizerRun = { id: 'fixture-run', directoryName: 'fixture-directory', kind: 'rename', status: 'succeeded', createdAt: '2026-09-29T00:00:00Z', updatedAt: '', changes: [{ source: 'a.txt', target: 'archive-a.txt', size: 1, sha256: 'a'.repeat(64), stage: '.geiit-stage-fixture' }] };
beforeEach(() => {
  state.organizerBusy = false; state.organizerRuns = []; state.runFileOrganizer.mockReset().mockResolvedValue('fixture-run');
  state.inspectOrganizerRun.mockReset().mockResolvedValue(undefined);
  window.showDirectoryPicker = vi.fn().mockResolvedValue(new MemoryDirectory({ 'a.txt': 'A' }));
});
afterEach(() => { cleanup(); delete window.showDirectoryPicker; vi.restoreAllMocks(); });

it('drops old directory write access when ordinary files are selected and invalidates changed plans', async () => {
  const user = userEvent.setup(); render(<FileOrganizer />);
  await user.click(screen.getByRole('button', { name: '选择可整理目录' }));
  await screen.findByText('当前可写目录：fixture-directory');
  expect(window.showDirectoryPicker).toHaveBeenCalledWith({ mode: 'readwrite' });
  await user.click(screen.getByRole('button', { name: '生成变更清单' }));
  expect(screen.getByRole('button', { name: '应用可整理项目' })).toBeEnabled();
  fireEvent.change(screen.getByLabelText('文件名前缀'), { target: { value: 'new' } });
  expect(screen.queryByRole('region', { name: '整理计划' })).not.toBeInTheDocument();
  await user.upload(screen.getByLabelText('选择待整理文件'), new File(['B'], 'b.txt'));
  await user.click(screen.getByRole('button', { name: '生成变更清单' }));
  expect(screen.getByText('当前为只读清单，无可写目录。')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '应用可整理项目' })).toBeDisabled();
  expect(state.runFileOrganizer).not.toHaveBeenCalled();
});
it('requires directory reselection and a preview before explicit undo confirmation', async () => {
  state.organizerRuns = [record]; const user = userEvent.setup(); render(<FileOrganizer />);
  await user.click(screen.getByText(/整理 · fixture-directory/));
  expect(screen.getByRole('button', { name: '预览撤销' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '选择可整理目录' }));
  await screen.findByText('当前可写目录：fixture-directory');
  await user.click(screen.getByRole('button', { name: '预览撤销' }));
  expect(state.runFileOrganizer).not.toHaveBeenCalled();
  expect(screen.getByRole('region', { name: '整理计划' })).toHaveTextContent('archive-a.txt');
  await user.click(screen.getByRole('button', { name: '确认撤销所选目录中的变更' }));
  await waitFor(() => expect(state.runFileOrganizer).toHaveBeenCalledWith(expect.any(MemoryDirectory), [expect.objectContaining({ source: 'archive-a.txt', target: 'a.txt', sha256: 'a'.repeat(64) })], record.id));
  await screen.findByRole('status');
});
it('disables all editing and duplicate apply while the action is in progress', async () => {
  let finish!: (id: string) => void; state.runFileOrganizer.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const user = userEvent.setup(); render(<FileOrganizer />);
  await user.click(screen.getByRole('button', { name: '选择可整理目录' })); await screen.findByText('当前可写目录：fixture-directory');
  await user.click(screen.getByRole('button', { name: '生成变更清单' }));
  await user.dblClick(screen.getByRole('button', { name: '应用可整理项目' }));
  expect(state.runFileOrganizer).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('文件名前缀')).toBeDisabled();
  expect(screen.getByRole('button', { name: '选择可整理目录' })).toBeDisabled();
  finish('fixture-run'); await waitFor(() => expect(screen.getByLabelText('文件名前缀')).toBeEnabled());
});
it('shows uncertain records and offers read-only reconciliation, without automatic replay', async () => {
  state.organizerRuns = [{ ...record, status: 'interrupted', retainedFiles: ['.geiit-stage-fixture'] }];
  const user = userEvent.setup(); render(<FileOrganizer />);
  await user.click(screen.getByText(/整理 · fixture-directory.*中断待核验/));
  expect(screen.getByRole('button', { name: '删除记录' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '预览撤销' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '选择可整理目录' })); await screen.findByText('当前可写目录：fixture-directory');
  await user.click(screen.getByRole('button', { name: '核验目录' }));
  await screen.findByText(/目录核验完成/);
  expect(state.inspectOrganizerRun).toHaveBeenCalledWith(expect.any(MemoryDirectory), record.id);
  expect(state.runFileOrganizer).not.toHaveBeenCalled();
});
it('rejects more than 500 files without silently producing a partial plan', async () => {
  const user = userEvent.setup(); render(<FileOrganizer />);
  fireEvent.change(screen.getByLabelText('选择待整理文件'), { target: { files: Array.from({ length: 501 }, (_, index) => new File(['A'], `${index}.txt`)) } });
  expect(screen.getByRole('alert')).toHaveTextContent('最多选择 500');
  expect(screen.getByText('已选择 0 个文件')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '生成变更清单' }));
  expect(screen.queryByRole('region', { name: '整理计划' })).not.toBeInTheDocument();
});
