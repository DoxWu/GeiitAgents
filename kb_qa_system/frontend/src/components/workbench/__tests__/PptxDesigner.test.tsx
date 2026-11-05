import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TaskRun, WorkArtifact } from '@/types/workbench';
import { PptxDesigner } from '../PptxDesigner';

const { state } = vi.hoisted(() => ({ state: { unlocked: true, profiles: [], taskRuns: [] as TaskRun[], artifacts: [] as WorkArtifact[], pptxDraft: null, accountModel: null, savePptxDraft: vi.fn() } }));
vi.mock('@/store/workbenchStore', () => ({ ACCOUNT_MODEL_ID: '$account', useWorkbenchStore: Object.assign((select?: (value: typeof state) => unknown) => select ? select(state) : state, { getState: () => state }) }));
vi.mock('@/hooks/useWorkbenchFence', () => ({ useWorkbenchFence: () => () => () => true }));
vi.mock('../ImageGenerator', () => ({ ImageGenerator: () => null }));
vi.mock('../CompositionCanvas', () => ({ CompositionCanvas: () => null }));
beforeEach(() => { state.taskRuns = []; state.artifacts = []; state.savePptxDraft.mockReset().mockResolvedValue(undefined); });
afterEach(cleanup);
const task = (patch: Partial<TaskRun>): TaskRun => ({ id: 'ppt-task', type: 'document.generate-markdown', title: '旧演示文稿', instruction: '整理演示内容', profileId: '', status: 'succeeded', createdAt: '', updatedAt: '', artifactIds: [], toolRunIds: [], ...patch });
it('loads a saved PPT design into the embedded editor and clears it for a new session', () => {
  const source = task({ sourceName: 'pptx-layout.json', sourceContent: JSON.stringify({ title: '已保存版式', theme: { primary: '#187a72', secondary: '#d59b45', background: '#f4f6f3', surface: '#ffffff', text: '#202b29' }, slides: [{ id: 's1', title: '设计中的第一页', layout: 'title', content: '保留的正文', topic: '' }] }) });
  state.taskRuns = [source];
  const view = render(<PptxDesigner embedded sourceTask={source} />);
  expect(screen.getByLabelText('演示文稿标题')).toHaveValue('已保存版式');
  expect(screen.getByLabelText('本页标题')).toHaveValue('设计中的第一页');
  expect(screen.getByLabelText('文字内容')).toHaveValue('保留的正文');
  expect(screen.queryByLabelText('设计与生成记录')).not.toBeInTheDocument();
  view.rerender(<PptxDesigner embedded newSession={1} />);
  expect(screen.getByLabelText('演示文稿标题')).toHaveValue('新建演示文稿');
  expect(screen.getByLabelText('文字内容')).toHaveValue('');
});
it('turns legacy PPTX task content into an editable slide design', () => {
  const source = task({ outputFormat: 'pptx', artifactIds: ['a1'] });
  state.artifacts = [{ id: 'a1', kind: 'markdown', content: '## 历史第一页\n\n保留原有文字', finishReason: 'stop' } as WorkArtifact];
  render(<PptxDesigner embedded sourceTask={source} />);
  expect(screen.getByLabelText('演示文稿标题')).toHaveValue('旧演示文稿');
  expect(screen.getByLabelText('本页标题')).toHaveValue('历史第一页');
  expect(screen.getByLabelText('文字内容')).toHaveValue('保留原有文字');
});
