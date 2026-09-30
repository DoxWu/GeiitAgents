import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TaskRun } from '@/types/workbench';
import { ChartTasks } from '../ChartTasks';

const { state } = vi.hoisted(() => ({ state: { taskRuns: [] as TaskRun[], artifacts: [], toolRuns: [], startChartTask: vi.fn(), storageError: null } }));
vi.mock('@/store/workbenchStore', () => ({ useWorkbenchStore: () => state }));
beforeEach(() => { state.taskRuns = []; state.startChartTask.mockReset().mockResolvedValue('chart:fixture'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('previews every selected series and clears approval when selection changes', async () => {
  const user = userEvent.setup(); render(<ChartTasks />);
  fireEvent.change(screen.getByLabelText('CSV 数据'), { target: { value: '月份,收入,成本\n一月,20,5\n二月,30,8' } });
  await user.click(screen.getByRole('checkbox', { name: '数值列：成本' }));
  await user.click(screen.getByRole('button', { name: '检查并预览' }));
  expect(screen.getByText(/2 个系列/)).toBeInTheDocument();
  await user.click(screen.getByText('查看完整数值'));
  const table = within(screen.getByRole('table', { name: '图表完整数据' }));
  expect(table.getByRole('columnheader', { name: '收入（元）' })).toBeInTheDocument();
  expect(table.getByRole('cell', { name: '8' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '保存图表任务' }));
  expect(state.startChartTask).toHaveBeenCalledWith(expect.objectContaining({ valueColumn: 1, valueColumns: [1, 2] }), expect.any(String));
  await user.click(screen.getByRole('button', { name: '检查并预览' }));
  await user.click(screen.getByRole('checkbox', { name: '数值列：成本' }));
  expect(screen.getByRole('button', { name: '保存图表任务' })).toBeDisabled();
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
});
it('selects and saves a single-series pie chart', async () => {
  const user = userEvent.setup(); render(<ChartTasks />);
  fireEvent.change(screen.getByLabelText('CSV 数据'), { target: { value: 'Category,Share\nA,3\nB,1' } });
  await user.selectOptions(screen.getByLabelText('图表类型'), 'pie');
  await user.click(screen.getByRole('button', { name: '检查并预览' }));
  expect(screen.getByRole('img')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '保存图表任务' }));
  expect(state.startChartTask).toHaveBeenCalledWith(expect.objectContaining({ chartType: 'pie', valueColumns: [1] }), expect.any(String));
});

it('removes a newly selected category from numeric series and rejects an empty selection', async () => {
  const user = userEvent.setup(); render(<ChartTasks />);
  fireEvent.change(screen.getByLabelText('CSV 数据'), { target: { value: '分类,值1,值2\na,2,3' } });
  await user.click(screen.getByRole('checkbox', { name: '数值列：值2' }));
  await user.selectOptions(screen.getByLabelText('分类列'), '1');
  expect(screen.getByRole('checkbox', { name: '数值列：值1' })).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: '数值列：值1' })).toBeDisabled();
  await user.click(screen.getByRole('checkbox', { name: '数值列：值2' }));
  await user.click(screen.getByRole('button', { name: '检查并预览' }));
  expect(screen.getByRole('alert')).toHaveTextContent('1–6');
  expect(state.startChartTask).not.toHaveBeenCalled();
});
it('restores legacy input after a multi-series draft without inheriting its selection', async () => {
  state.taskRuns = [{ id: 'legacy', type: 'chart.generate', title: '旧任务', status: 'succeeded', profileId: '', instruction: '', createdAt: '', updatedAt: '', toolRunIds: [], artifactIds: [], chartInput: { title: '旧任务', csv: '分类,数值\na,2', categoryColumn: 0, valueColumn: 1, chartType: 'bar', unit: '' } }];
  const user = userEvent.setup(); render(<ChartTasks />);
  fireEvent.change(screen.getByLabelText('CSV 数据'), { target: { value: '分类,数值,额外\na,2,3' } });
  await user.click(screen.getByRole('checkbox', { name: '数值列：额外' }));
  await user.click(screen.getByRole('button', { name: '复用图表输入' }));
  expect(screen.getAllByRole('checkbox').filter(input => (input as HTMLInputElement).checked)).toHaveLength(1);
  expect(screen.getByRole('checkbox', { name: '数值列：数值' })).toBeChecked();
  await user.click(screen.getByRole('button', { name: '检查并预览' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
