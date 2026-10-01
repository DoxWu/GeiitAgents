import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import JSZip from 'jszip';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { Workflows } from '../Workflows';
import { useWorkbenchStore as store } from '@/store/workbenchStore';
import { newWorkflow, newWorkflowNode } from '@/workflows/definition';

vi.mock('@/store/workbenchStore', async () => {
  const { create } = await import('zustand');
  return { ACCOUNT_MODEL_ID: '$account', useWorkbenchStore: create(() => ({ workflows: [], workflowDraft: null, workflowDraftSaving: false, profiles: [], taskRuns: [], toolRuns: [], artifacts: [], generationPreviews: {}, storageError: null, accountModel: null,
    stageWorkflowDraft: vi.fn(() => true), clearWorkflowDraft: vi.fn().mockResolvedValue(undefined), saveWorkflow: vi.fn(), startWorkflow: vi.fn(), resumeWorkflow: vi.fn(), removeWorkflow: vi.fn(), retryStorage: vi.fn() })) };
});
beforeEach(() => {
  store.setState({ workflows: [], workflowDraft: null, workflowDraftSaving: false, profiles: [], taskRuns: [], toolRuns: [], artifacts: [], storageError: null, accountModel: null });
  vi.mocked(store.getState().resumeWorkflow).mockReset().mockResolvedValue('resumed');
  vi.mocked(store.getState().saveWorkflow).mockReset().mockImplementation(async d => { const saved = { ...d, revision: d.revision + 1 }; store.setState({ workflows: [saved] }); return saved; });
  vi.mocked(store.getState().startWorkflow).mockReset().mockResolvedValue('run');
  vi.mocked(store.getState().retryStorage).mockReset().mockResolvedValue();
  vi.mocked(store.getState().stageWorkflowDraft).mockReset().mockReturnValue(true);
  vi.mocked(store.getState().clearWorkflowDraft).mockReset().mockResolvedValue();
});
it('separates continuation consent from new runs and invalidates it on history or connection changes', async () => {
  const node = newWorkflowNode('generate_document', 0), d = { ...newWorkflow(), revision: 1, nodes: [node] };
  const run = { id: 'failed', type: 'workflow.run' as const, workflow: { definition: d, input: { reference: 'original', csv: '' } }, title: 'history', profileId: 'relay', instruction: '', status: 'failed' as const,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), toolRunIds: ['partial'], artifactIds: [] };
  store.setState({ workflows: [d], profiles: [{ id: 'relay', name: 'cloud', mode: 'relay', baseUrl: 'https://example.test/v1', model: 'fixture', hasKey: true }],
    taskRuns: [run, { ...run, id: 'other', toolRunIds: [] }], toolRuns: [{ id: 'partial', taskId: run.id, workflowNodeId: node.id, tool: 'model.complete', status: 'succeeded', finishReason: 'length', startedAt: run.createdAt }] });
  const user = userEvent.setup(); render(<Workflows />); await user.selectOptions(screen.getByLabelText('已保存工作流'), d.id);
  await user.click(screen.getByLabelText(/允许本次按已保存工作流/));
  const resume = screen.getByRole('button', { name: '从失败步骤继续' });
  await user.click(resume); expect(store.getState().resumeWorkflow).not.toHaveBeenCalled();
  const consent = screen.getByLabelText('确认续跑时重新向云端模型发送步骤内容');
  await user.click(consent); await user.selectOptions(screen.getByLabelText('选择工作流运行'), 'other'); expect(consent).not.toBeChecked();
  await user.click(consent);
  act(() => store.setState(state => ({ profiles: state.profiles.map(p => ({ ...p, model: 'changed' })) })));
  expect(consent).not.toBeChecked();
  await user.selectOptions(screen.getByLabelText('选择工作流运行'), 'failed');
  await user.click(consent);
  vi.mocked(store.getState().resumeWorkflow).mockRejectedValueOnce(new Error('fixture failure'));
  await user.click(screen.getByRole('button', { name: '重试此步骤并继续' }));
  expect(store.getState().resumeWorkflow).toHaveBeenCalledWith('failed', node.id, true);
  expect(consent).not.toBeChecked();
  expect(await screen.findByRole('alert')).toHaveTextContent('fixture failure');
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
it('configures a condition node and labels its outgoing branch', async () => {
  const user = userEvent.setup(); render(<Workflows />);
  const addCondition = screen.getAllByRole('button').find(button => button.textContent?.includes('\u6761\u4ef6'))!;
  await user.click(addCondition);
  await user.selectOptions(screen.getByLabelText(/\u6761\u4ef6\u6765\u6e90/), 'csv');
  await user.selectOptions(screen.getByLabelText(/\u6761\u4ef6\u64cd\u4f5c/), 'contains');
  await user.type(screen.getByLabelText(/\u6761\u4ef6\u6bd4\u8f83\u503c/), 'ready');
  const addMarkdown = screen.getAllByRole('button').find(button => button.textContent?.includes('\u6574\u7406'))!;
  await user.click(addMarkdown); await user.click(addMarkdown);
  const from = screen.getByLabelText(/\u524d\u7f6e\u6b65\u9aa4/), to = screen.getByLabelText(/\u540e\u7eed\u6b65\u9aa4/);
  const options = from.querySelectorAll('option');
  await user.selectOptions(from, options[1].getAttribute('value')!); await user.selectOptions(to, options[2].getAttribute('value')!);
  await user.selectOptions(screen.getByLabelText(/\u5206\u652f\u503c/), 'true'); await user.click(screen.getByRole('button', { name: /\u8fde\u63a5/ }));
  await user.click(screen.getByRole('button', { name: /\u4fdd\u5b58/ })); await waitFor(() => expect(store.getState().saveWorkflow).toHaveBeenCalled());
  const saved = vi.mocked(store.getState().saveWorkflow).mock.calls[0][0];
  expect(saved.nodes[0].kind).toBe('condition'); expect(saved.nodes[0].condition).toMatchObject({ source: 'csv', value: 'ready' }); expect(saved.edges[0].when).toBe('true');
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
  expect(screen.getByText(/本机草稿未确认保存/)).toBeVisible();
  expect(screen.getByRole('button', { name: '手动运行工作流' })).toBeDisabled();
});

it('stages definition edits without including this run input', async () => {
  const user = userEvent.setup(); render(<Workflows />);
  await user.type(screen.getByLabelText('工作流名称'), '周报');
  expect(store.getState().stageWorkflowDraft).toHaveBeenCalled();
  const staged = vi.mocked(store.getState().stageWorkflowDraft).mock.calls.at(-1)![0];
  expect(staged.name).toBe('新工作流周报');
  expect(staged).not.toHaveProperty('input');
  const stageCalls = vi.mocked(store.getState().stageWorkflowDraft).mock.calls.length;
  await user.type(screen.getByLabelText('工作流参考材料'), '仅本次运行');
  expect(store.getState().stageWorkflowDraft).toHaveBeenCalledTimes(stageCalls);
});

it('restores a staged definition but requires an explicit save before running', async () => {
  const draft = { ...newWorkflow(), name: '恢复的草稿', nodes: [newWorkflowNode('create_document', 0)] };
  store.setState({ workflowDraft: draft });
  render(<Workflows />);
  expect(screen.getByLabelText('工作流名称')).toHaveValue('恢复的草稿');
  expect(screen.getByText(/修改已加密保存为本机草稿/)).toBeVisible();
  expect(screen.getByRole('button', { name: '手动运行工作流' })).toBeDisabled();
  await userEvent.setup().click(screen.getByRole('button', { name: '保存工作流' }));
  await waitFor(() => expect(store.getState().saveWorkflow).toHaveBeenCalledWith(draft));
});

it('imports a visible XLSX sheet into the workflow input and preserves references', async () => {
  const zip = new JSZip();
  zip.file('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="输入数据" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  zip.file('xl/worksheets/sheet1.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>月份</t></is></c><c r="B1" t="inlineStr"><is><t>数量</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>一月</t></is></c><c r="B2"><v>12</v></c></row></sheetData></worksheet>');
  const user = userEvent.setup(), view = render(<Workflows />);
  await user.type(screen.getByLabelText('工作流参考材料'), '保留此参考');
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  await user.upload(screen.getByLabelText('选择工作流 CSV 或 XLSX 文件'), new File([bytes], 'input.xlsx'));
  expect(await screen.findByRole('status')).toHaveTextContent('工作表：输入数据');
  expect(screen.getByLabelText('工作流 CSV')).toHaveValue('月份,数量\n一月,12');
  expect(screen.getByLabelText('工作流参考材料')).toHaveValue('保留此参考');
  view.unmount();
});

it('keeps the previous workflow CSV when an unsupported upload fails', async () => {
  const user = userEvent.setup(); render(<Workflows />);
  fireEvent.change(screen.getByLabelText('工作流 CSV'), { target: { value: '月份,数量\n一月,12' } });
  await user.upload(screen.getByLabelText('选择工作流 CSV 或 XLSX 文件'), new File(['invalid'], 'input.xlsx'));
  expect(await screen.findByRole('alert')).toBeVisible();
  expect(screen.getByLabelText('工作流 CSV')).toHaveValue('月份,数量\n一月,12');
});
