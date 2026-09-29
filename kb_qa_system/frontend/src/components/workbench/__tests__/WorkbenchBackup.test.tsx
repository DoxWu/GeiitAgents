import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkbenchBackup } from '../WorkbenchBackup';
import { useWorkbenchStore as store } from '@/store/workbenchStore';
import { summarizeVault } from '@/services/vaultBackup';

vi.mock('@/store/workbenchStore', async () => {
  const { create } = await import('zustand');
  return { useWorkbenchStore: create(() => ({ unlocked: false, vaultTransferBusy: false, vaultRestorePreview: null, organizerBusy: false,
    exportWorkbenchBackup: vi.fn(), prepareWorkbenchRestore: vi.fn(), commitWorkbenchRestore: vi.fn(), cancelVaultTransfer: vi.fn(), lock: vi.fn() })) };
});
const summary = summarizeVault({ profiles: [], conversations: [] }, '2026-09-29T00:00:00.000Z');
beforeEach(() => {
  vi.resetAllMocks(); store.setState({ unlocked: false, vaultTransferBusy: false, vaultRestorePreview: null, organizerBusy: false });
  vi.mocked(store.getState().cancelVaultTransfer).mockImplementation(() => store.setState({ vaultTransferBusy: false, vaultRestorePreview: null }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function fill(label: string, value: string) { fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } }); }

it('allows a new device to precheck while locked, clears passwords and requires acknowledgement', async () => {
  vi.mocked(store.getState().prepareWorkbenchRestore).mockImplementation(async () => store.setState({ vaultRestorePreview: { id: 'preview', replacing: false, summary } }));
  render(<WorkbenchBackup onUnlock={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('工作台备份文件'), { target: { files: [new File(['encrypted'], 'synthetic.geiitwork')] } });
  fill('此备份的口令', '1234'); fill('恢复后的新解锁口令', '5678'); fill('确认新解锁口令', '5678');
  fireEvent.click(screen.getByText('解密并预检查备份'));
  const confirm = await screen.findByText('确认恢复工作台');
  expect(confirm).toBeDisabled(); expect(screen.getByLabelText('此备份的口令')).toHaveValue('');
  expect(store.getState().commitWorkbenchRestore).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText('我已核对备份内容并确认整体恢复到本机工作台')); fireEvent.click(confirm);
  await waitFor(() => expect(store.getState().commitWorkbenchRestore).toHaveBeenCalledWith('preview'));
});

it('invalidates a prepared preview when the selected file or password changes', async () => {
  render(<WorkbenchBackup onUnlock={vi.fn()} />);
  act(() => store.setState({ vaultRestorePreview: { id: 'preview', replacing: true, summary } }));
  fill('此备份的口令', 'changed'); expect(screen.queryByText('确认恢复工作台')).not.toBeInTheDocument();
  act(() => store.setState({ vaultRestorePreview: { id: 'preview2', replacing: true, summary } }));
  fireEvent.change(screen.getByLabelText('工作台备份文件'), { target: { files: [] } });
  expect(screen.queryByText('确认恢复工作台')).not.toBeInTheDocument();
});

it('defaults to no keys and does not download a late result after leaving the page', async () => {
  store.setState({ unlocked: true });
  let finish!: (value: { file: Blob; summary: typeof summary }) => void;
  vi.mocked(store.getState().exportWorkbenchBackup).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const download = vi.spyOn(URL, 'createObjectURL');
  const view = render(<WorkbenchBackup onUnlock={vi.fn()} />);
  expect(screen.getByLabelText('在加密备份中包含模型 API Key')).not.toBeChecked();
  fill('备份口令', '1234'); fill('确认备份口令', '1234'); fireEvent.click(screen.getByText('下载加密工作台备份'));
  expect(store.getState().exportWorkbenchBackup).toHaveBeenCalledWith('1234', false);
  view.unmount(); await act(async () => finish({ file: new Blob(['encrypted']), summary }));
  expect(download).not.toHaveBeenCalled(); expect(store.getState().cancelVaultTransfer).toHaveBeenCalled();
});

it('retains a quota failure preview for retry without claiming success', async () => {
  vi.mocked(store.getState().commitWorkbenchRestore).mockRejectedValue(new Error('原密钥库未更改。可释放空间后重试。'));
  render(<WorkbenchBackup onUnlock={vi.fn()} />);
  act(() => store.setState({ vaultRestorePreview: { id: 'preview', replacing: true, summary } }));
  fireEvent.click(screen.getByLabelText('我已核对备份内容并确认整体恢复到本机工作台')); fireEvent.click(screen.getByText('确认恢复工作台'));
  expect(await screen.findByRole('alert')).toHaveTextContent('原密钥库未更改'); expect(screen.getByText('确认恢复工作台')).toBeEnabled();
  expect(screen.queryByText(/恢复已完成/)).not.toBeInTheDocument();
});
