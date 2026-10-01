import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OfficeToolTasks } from '../OfficeToolTasks';
import { useWorkbenchStore as store } from '@/store/workbenchStore';
import { useAuthStore } from '@/store/authStore';
import { parseFirstXlsxSheet } from '@/officeTasks/xlsx';
vi.mock('@/officeTasks/xlsx', () => ({ parseFirstXlsxSheet: vi.fn() }));

vi.mock('@/store/workbenchStore', async () => {
  const { create } = await import('zustand');
  return { ACCOUNT_MODEL_ID: 'account', useWorkbenchStore: create(() => ({ profiles: [], accountModel: null, taskRuns: [], toolRuns: [], artifacts: [], storageError: null,
    startOfficeToolTask: vi.fn(), cancelTask: vi.fn(), removeTask: vi.fn(), retryStorage: vi.fn() })) };
});
vi.mock('@/store/authStore', async () => {
  const { create } = await import('zustand');
  return { useAuthStore: create(() => ({ user: null, isAuthenticated: false })) };
});
beforeEach(() => {
  vi.resetAllMocks();
  store.setState({ profiles: [{ id: 'cloud', name: 'Cloud', model: 'fixture', mode: 'relay', baseUrl: 'https://models.example/v1', hasKey: true }], accountModel: null, taskRuns: [], toolRuns: [], artifacts: [], storageError: null });
  useAuthStore.setState({ user: null, isAuthenticated: false });
  vi.mocked(store.getState().startOfficeToolTask).mockResolvedValue('new-task');
});
afterEach(cleanup);
it('imports the first XLSX sheet locally, clears consent and preserves input on failure', async () => {
  vi.mocked(parseFirstXlsxSheet).mockResolvedValue({ csv: '月份,销量\n一月,12', sheetName: '销量' });
  const file = new File(['fixture'], 'sales.xlsx'); Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(7) });
  render(<OfficeToolTasks />); fireEvent.click(screen.getByLabelText(/允许本次最多 6 轮请求/));
  const picker = screen.getByLabelText('导入任务 CSV / XLSX（CSV 400 KB，XLSX 2 MB）');
  await act(async () => fireEvent.change(picker, { target: { files: [file] } }));
  expect(screen.getByLabelText('任务 CSV（可选）')).toHaveValue('月份,销量\n一月,12'); expect(screen.getByText('工作表：销量')).toBeVisible();
  expect(screen.getByLabelText(/允许本次最多 6 轮请求/)).not.toBeChecked();
  expect(screen.getByLabelText('允许本次网络搜索')).not.toBeChecked();
  vi.mocked(parseFirstXlsxSheet).mockRejectedValue(new Error('公式不支持'));
  await act(async () => fireEvent.change(picker, { target: { files: [file] } }));
  expect(screen.getByRole('alert')).toHaveTextContent('公式不支持'); expect(screen.getByLabelText('任务 CSV（可选）')).toHaveValue('月份,销量\n一月,12');
  expect(store.getState().startOfficeToolTask).not.toHaveBeenCalled();
});

it('requires fresh cloud consent after input or account changes and consumes it once', async () => {
  render(<OfficeToolTasks />);
  const start = screen.getByRole('button', { name: '开始多步骤任务' });
  const consent = screen.getByLabelText(/允许本次最多 6 轮请求/);
  const searchConsent = screen.getByLabelText('允许本次网络搜索');
  fireEvent.change(screen.getByLabelText('任务标题'), { target: { value: '报告' } });
  fireEvent.change(screen.getByLabelText('办公目标'), { target: { value: '写周报' } });
  expect(start).toBeDisabled();
  fireEvent.click(searchConsent); expect(start).toBeDisabled();
  fireEvent.click(consent); expect(start).toBeEnabled();
  fireEvent.change(screen.getByLabelText('参考材料（可选）'), { target: { value: '新材料' } });
  expect(start).toBeDisabled(); expect(searchConsent).not.toBeChecked();
  fireEvent.click(consent);
  act(() => useAuthStore.setState({ isAuthenticated: true, user: { id: 2 } as ReturnType<typeof useAuthStore.getState>['user'] }));
  expect(start).toBeDisabled();
  fireEvent.click(consent);
  act(() => store.setState({ profiles: [{ ...store.getState().profiles[0], baseUrl: 'https://changed.example/v1' }] }));
  expect(start).toBeDisabled();
  fireEvent.click(consent); fireEvent.click(searchConsent); await act(async () => fireEvent.click(start));
  expect(store.getState().startOfficeToolTask).toHaveBeenCalledWith('cloud', expect.objectContaining({ title: '报告', sourceContent: '新材料' }), true, true);
  expect(start).toBeDisabled();
});

it.each(['edit', 'unmount'] as const)('ignores late file contents after %s', async reason => {
  let finish!: (buffer: ArrayBuffer) => void;
  const file = new File(['original'], 'report.md', { type: 'text/markdown' });
  Object.defineProperty(file, 'arrayBuffer', { value: () => new Promise<ArrayBuffer>(resolve => { finish = resolve; }) });
  render(<OfficeToolTasks />);
  fireEvent.change(screen.getByLabelText('导入参考文件（MD/TXT，最多 200 KB）'), { target: { files: [file] } });
  if (reason === 'edit') fireEvent.change(screen.getByLabelText('参考材料（可选）'), { target: { value: '用户新输入' } });
  else cleanup();
  await act(async () => finish(new TextEncoder().encode('迟到的文件内容').buffer));
  if (reason === 'edit') expect(screen.getByLabelText('参考材料（可选）')).toHaveValue('用户新输入');
  expect(store.getState().startOfficeToolTask).not.toHaveBeenCalled();
});
