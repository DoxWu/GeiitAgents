import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TaskRun } from '@/types/workbench';
import { DocumentTasks } from '../DocumentTasks';

const { state } = vi.hoisted(() => ({ state: {
  taskRuns: [] as TaskRun[], artifacts: [], toolRuns: [], generationPreviews: {}, unlocked: true,
  profiles: [{ id: 'local', name: '本机模型', mode: 'local', model: 'test', baseUrl: 'http://localhost:1234/v1' }],
  accountModel: null, startDocumentTask: vi.fn(), removeTask: vi.fn(),
} }));
vi.mock('@/store/workbenchStore', () => ({ ACCOUNT_MODEL_ID: '$account', useWorkbenchStore: Object.assign(() => state, { getState: () => state }) }));
vi.mock('@/hooks/useWorkbenchFence', () => ({ useWorkbenchFence: () => () => () => state.unlocked }));
vi.mock('../DocumentArtifact', () => ({ DocumentArtifact: () => <p>已保存成果</p> }));
vi.mock('../ReferenceLibrary', () => ({ ReferenceLibrary: () => <div>参考资料库</div> }));
vi.mock('../PptxDesigner', () => ({ PptxDesigner: ({ sourceTask }: { sourceTask?: TaskRun }) => <section aria-label="PPT 页面设计器">{sourceTask ? `恢复设计：${sourceTask.title}` : '新演示文稿设计'}</section> }));
const task = (patch: Partial<TaskRun> = {}): TaskRun => ({ id: 'doc-1', type: 'document.generate-markdown', title: '项目报告', instruction: '整理本周进展', status: 'succeeded', profileId: 'local', createdAt: '2026-11-05T01:00:00Z', updatedAt: '2026-11-05T01:00:00Z', toolRunIds: [], artifactIds: [], outputFormat: 'docx', ...patch });
beforeEach(() => { state.taskRuns = [task()]; state.startDocumentTask.mockReset(); });
afterEach(cleanup);

it('pins creation before history and separates the new form from task details', async () => {
  const user = userEvent.setup(); render(<DocumentTasks />);
  const sidebar = within(screen.getByRole('complementary', { name: '文档任务列表' }));
  expect(sidebar.getAllByRole('button')[0]).toHaveTextContent('新建文档任务');
  expect(screen.getByRole('region', { name: '任务详情' })).toBeVisible();
  expect(screen.queryByRole('button', { name: '开始生成' })).not.toBeInTheDocument();
  await user.click(sidebar.getByRole('button', { name: '新建文档任务' }));
  expect(screen.getByRole('heading', { name: '新建文档任务' })).toBeVisible();
  expect(screen.queryByRole('region', { name: '任务详情' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '开始生成' })).toBeVisible();
  await user.click(sidebar.getByRole('button', { name: /项目报告/ }));
  expect(screen.getByRole('heading', { name: '文档任务详情' })).toBeVisible();
  expect(screen.queryByRole('button', { name: '开始生成' })).not.toBeInTheDocument();
});
it('reuses history in a new form with its format and can clear it for a fresh task', async () => {
  state.taskRuns = [task({ outputFormat: 'xlsx' })];
  const user = userEvent.setup(); render(<DocumentTasks />);
  await user.click(screen.getByRole('button', { name: '复用输入新建' }));
  expect(screen.getByLabelText('文档标题')).toHaveValue('项目报告');
  expect(screen.getByLabelText('生成要求')).toHaveValue('整理本周进展');
  expect(screen.getByRole('combobox', { name: '输出文件类型' })).toHaveValue('xlsx');
  expect(screen.queryByRole('region', { name: '任务详情' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '新建文档任务' }));
  expect(screen.getByLabelText('文档标题')).toHaveValue('');
  expect(screen.getByLabelText('生成要求')).toHaveValue('');
});
it('keeps PPT creation and saved designs within the common document task list', async () => {
  state.taskRuns = [task({ sourceName: 'pptx-layout.json' })];
  const user = userEvent.setup(); render(<DocumentTasks />);
  await user.click(screen.getByRole('button', { name: '继续编辑与导出 PPTX' }));
  expect(await screen.findByRole('region', { name: 'PPT 页面设计器' })).toHaveTextContent('恢复设计：项目报告');
  expect(screen.getByRole('combobox', { name: '输出文件类型' })).toHaveValue('pptx');
  expect(screen.getByRole('complementary', { name: '文档任务列表' })).toBeVisible();
  expect(screen.queryByRole('button', { name: '开始生成' })).not.toBeInTheDocument();
});
it('does not switch away from a new task when an older generation finishes', async () => {
  let finish!: (id: string) => void;
  state.startDocumentTask.mockImplementation(() => new Promise(resolve => { state.taskRuns.unshift(task({ id: 'running', title: '新报告', status: 'running' })); finish = resolve; }));
  const user = userEvent.setup(); const view = render(<DocumentTasks />);
  await user.click(screen.getByRole('button', { name: '新建文档任务' }));
  fireEvent.change(screen.getByLabelText('文档标题'), { target: { value: '新报告' } });
  fireEvent.change(screen.getByLabelText('生成要求'), { target: { value: '整理内容' } });
  await user.click(screen.getByRole('button', { name: '开始生成' }));
  view.rerender(<DocumentTasks />);
  expect(screen.getByRole('region', { name: '任务详情' })).toHaveTextContent('新报告');
  await user.click(screen.getByRole('button', { name: '新建文档任务' }));
  await act(async () => finish('running'));
  expect(screen.getByRole('heading', { name: '新建文档任务' })).toBeVisible();
  expect(screen.queryByRole('region', { name: '任务详情' })).not.toBeInTheDocument();
});
