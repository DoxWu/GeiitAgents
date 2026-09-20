import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import LocalKnowledgeAnswer from '../LocalKnowledgeAnswer';
const mock = vi.hoisted(() => ({ answer: vi.fn(), refresh: vi.fn(), save: vi.fn() }));
vi.mock('@/store/workbenchStore', () => ({ ACCOUNT_MODEL_ID: '$account', useWorkbenchStore: () => ({
  unlocked: true, profiles: [{ id: 'cloud', name: 'Cloud', mode: 'relay', baseUrl: 'https://example.test/v1', model: 'model', hasKey: true }],
  accountModel: null, accountLoading: false, accountError: null, answerKnowledge: mock.answer, refreshAccountModel: mock.refresh, saveKnowledgeAnswer: mock.save,
}) }));
const sources = [{ documentId: 'doc', name: 'policy.md', start: 0, end: 4, text: '测试资料', vector: [1], score: 1 }];
beforeEach(() => { vi.clearAllMocks(); mock.answer.mockResolvedValue({ content: '答案 [1]', model: 'model' }); });
afterEach(cleanup);
function mount() { return render(<MemoryRouter><LocalKnowledgeAnswer question="问题" sources={sources} /></MemoryRouter>); }
it('requires cloud consent for every request and resets it when selection changes', async () => {
  mount(); fireEvent.change(screen.getByLabelText('回答生成模型'), { target: { value: 'cloud' } });
  const button = screen.getByRole('button', { name: '根据所选来源生成回答' });
  expect(button).toBeDisabled(); expect(mock.answer).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText(/我允许本次/)); fireEvent.click(button);
  await waitFor(() => expect(screen.getByText('答案 [1]')).toBeInTheDocument());
  expect(mock.answer).toHaveBeenCalledWith('cloud', '问题', sources, true, expect.any(AbortSignal));
  expect(button).toBeDisabled();
  fireEvent.click(screen.getByLabelText(/我允许本次/));
  fireEvent.click(screen.getByLabelText(/来源 1：/));
  expect(screen.getByLabelText(/我允许本次/)).not.toBeChecked(); expect(button).toBeDisabled();
});
it('aborts pending generation when the search result component unmounts', async () => {
  mock.answer.mockImplementation(() => new Promise(() => {}));
  const view = mount(); fireEvent.change(screen.getByLabelText('回答生成模型'), { target: { value: 'cloud' } });
  fireEvent.click(screen.getByLabelText(/我允许本次/)); fireEvent.click(screen.getByRole('button', { name: '根据所选来源生成回答' }));
  const signal = mock.answer.mock.calls[0][4]; view.unmount(); expect(signal.aborted).toBe(true);
});

it('only saves explicitly and shows a retry after storage failure', async () => {
  mount(); fireEvent.change(screen.getByLabelText('回答生成模型'), { target: { value: 'cloud' } });
  fireEvent.click(screen.getByLabelText(/我允许本次/)); fireEvent.click(screen.getByRole('button', { name: '根据所选来源生成回答' }));
  await screen.findByText('答案 [1]'); expect(mock.save).not.toHaveBeenCalled();
  mock.save.mockRejectedValueOnce(new Error('本机保存失败')).mockImplementationOnce(answer => Promise.resolve(`knowledge-answer:${answer.id}`));
  fireEvent.click(screen.getByRole('button', { name: '保存为独立对话记录' }));
  await screen.findByRole('alert'); expect(screen.queryByText('已保存到工作台')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '保存为独立对话记录' }));
  expect(await screen.findByRole('button', { name: '已保存到工作台' })).toBeDisabled();
  expect(mock.save.mock.calls[0][0]).toBe(mock.save.mock.calls[1][0]);
  expect(mock.answer).toHaveBeenCalledTimes(1);
});
