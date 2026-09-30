import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { Workflows } from '../Workflows';
import { useWorkbenchStore as store } from '@/store/workbenchStore';
import { newWorkflow, newWorkflowNode } from '@/workflows/definition';

vi.mock('@/store/workbenchStore', async () => {
  const { create } = await import('zustand');
  return { ACCOUNT_MODEL_ID: '$account', useWorkbenchStore: create(() => ({ workflows: [], profiles: [], taskRuns: [], toolRuns: [], artifacts: [], generationPreviews: {}, storageError: null, accountModel: null,
    saveWorkflow: vi.fn(), startWorkflow: vi.fn(), removeWorkflow: vi.fn(), retryStorage: vi.fn() })) };
});
beforeEach(() => {
  store.setState({ workflows: [], profiles: [], taskRuns: [], storageError: null, accountModel: null });
  vi.mocked(store.getState().saveWorkflow).mockReset().mockImplementation(async d => { const saved = { ...d, revision: d.revision + 1 }; store.setState({ workflows: [saved] }); return saved; });
  vi.mocked(store.getState().startWorkflow).mockReset().mockResolvedValue('run');
  vi.mocked(store.getState().retryStorage).mockReset().mockResolvedValue();
});
it('edits nodes, connects them, rejects a cycle, and persists keyboard layout changes', async () => {
  const user = userEvent.setup(); render(<Workflows />);
  await user.click(screen.getByRole('button', { name: '添加检查 CSV' }));
  await user.click(screen.getByRole('button', { name: '添加整理 Markdown' }));
  const opts = screen.getByLabelText('前置步骤').querySelectorAll('option');
  await user.selectOptions(screen.getByLabelText('前置步骤'), opts[1].value); await user.selectOptions(screen.getByLabelText('后续步骤'), opts[2].value);
  await user.click(screen.getByRole('button', { name: '连接步骤' }));
  expect(screen.getByRole('button', { name: '移除此连线' })).toBeVisible();
  await user.selectOptions(screen.getByLabelText('前置步骤'), opts[2].value); await user.selectOptions(screen.getByLabelText('后续步骤'), opts[1].value);
  await user.click(screen.getByRole('button', { name: '连接步骤' })); expect(screen.getByRole('alert')).toHaveTextContent('循环依赖');
  fireEvent.keyDown(screen.getByRole('button', { name: '移动步骤 1' }), { key: 'ArrowRight' });
  await user.click(screen.getByRole('button', { name: '保存工作流' }));
  await waitFor(() => expect(store.getState().saveWorkflow).toHaveBeenCalled());
  const saved = vi.mocked(store.getState().saveWorkflow).mock.calls[0][0]; expect(saved.nodes[0].x).toBe(44); expect(saved.edges).toHaveLength(1);
});
it('requires consent for each cloud run and clears it when runtime input changes', async () => {
  const d = { ...newWorkflow(), revision: 1, nodes: [newWorkflowNode('generate_document', 0)] };
  store.setState({ workflows: [d], profiles: [{ id: 'relay', name: 'cloud', mode: 'relay', baseUrl: 'https://example.test/v1', model: 'fixture', hasKey: true }] });
  const user = userEvent.setup(); render(<Workflows />); await user.selectOptions(screen.getByLabelText('已保存工作流'), d.id);
  const run = screen.getByRole('button', { name: '手动运行工作流' }), consent = screen.getByLabelText(/允许本次按已保存工作流/);
  expect(run).toBeDisabled(); await user.click(consent); expect(run).toBeEnabled();
  await user.type(screen.getByLabelText('工作流参考材料', { exact: true }), 'changed'); expect(consent).not.toBeChecked(); expect(run).toBeDisabled();
  await user.click(consent); await user.click(run); expect(consent).not.toBeChecked();
  expect(store.getState().startWorkflow).toHaveBeenCalledWith(d.id, 1, { csv: '', reference: 'changed' }, 'relay', true);
});
it('allows a generating node to override the default connection and invalidates cloud consent', async () => {
  const node = newWorkflowNode('generate_document', 0), d = { ...newWorkflow(), revision: 1, nodes: [node] };
  store.setState({ workflows: [d], profiles: [
    { id: 'local', name: 'local', mode: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'local-model', hasKey: true },
    { id: 'relay', name: 'relay', mode: 'relay', baseUrl: 'https://example.test/v1', model: 'cloud-model', hasKey: true },
  ] });
  const user = userEvent.setup(); render(<Workflows />); await user.selectOptions(screen.getByLabelText('已保存工作流'), d.id);
  await user.selectOptions(screen.getByLabelText('此步骤模型连接'), 'relay');
  await user.click(screen.getByRole('button', { name: '保存工作流' }));
  await waitFor(() => expect(store.getState().saveWorkflow).toHaveBeenCalled());
  const run = screen.getByRole('button', { name: '手动运行工作流' });
  expect(run).toBeDisabled();
  await user.click(screen.getByLabelText(/允许本次按已保存工作流/)); expect(run).toBeEnabled();
  await user.selectOptions(screen.getByLabelText('此步骤模型连接'), '');
  expect(run).toBeDisabled();
});
it('does not mark unsaved edits saved when retrying unrelated storage failures', async () => {
  store.setState({ storageError: 'quota' });
  const user = userEvent.setup(); render(<Workflows />);
  await user.click(screen.getByRole('button', { name: '添加整理 Markdown' }));
  await user.click(screen.getByRole('button', { name: '重试本机保存' }));
  expect(screen.getByText(/有未保存修改/)).toBeVisible();
  expect(screen.getByRole('button', { name: '手动运行工作流' })).toBeDisabled();
});
