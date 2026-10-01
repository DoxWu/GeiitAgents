import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ModelConnections } from '../ModelConnections';
import { useWorkbenchStore as store } from '@/store/workbenchStore';
import { useAuthStore } from '@/store/authStore';
import type { ModelCatalog } from '@/services/modelDiscovery';

vi.mock('@/store/workbenchStore', async () => {
  const { create } = await import('zustand');
  return { useWorkbenchStore: create(() => ({ profiles: [], accountModel: null, accountLoading: false, accountError: null,
    saveProfile: vi.fn(), removeProfile: vi.fn(), discoverProfileModels: vi.fn(), testProfile: vi.fn(), testProfileToolSupport: vi.fn(), refreshAccountModel: vi.fn() })) };
});
vi.mock('@/store/authStore', async () => {
  const { create } = await import('zustand');
  return { useAuthStore: create(() => ({ user: null, isAuthenticated: false })) };
});

beforeEach(() => {
  vi.resetAllMocks();
  store.setState({ profiles: [], accountModel: null, accountLoading: false, accountError: null });
  useAuthStore.setState({ user: null, isAuthenticated: false });
  vi.mocked(store.getState().saveProfile).mockImplementation(async profile => { store.setState({ profiles: [{ ...profile, hasKey: false }] }); });
});
afterEach(cleanup);
function localDraft() {
  render(<ModelConnections />);
  fireEvent.change(screen.getByLabelText('调用方式'), { target: { value: 'local' } });
}

it('requires an explicit list request and retains manual model choice and optional token limit', async () => {
  vi.mocked(store.getState().discoverProfileModels).mockResolvedValue({ models: [{ id: 'available-chat' }], truncated: false });
  localDraft();
  expect(store.getState().discoverProfileModels).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'manual-chat' } });
  fireEvent.click(screen.getByText('获取模型列表'));
  await screen.findByLabelText('从列表选择模型');
  expect(screen.getByLabelText('模型名称')).toHaveValue('manual-chat');
  expect(screen.getByText('文本调用：未验证')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('从列表选择模型'), { target: { value: 'available-chat' } });
  expect(screen.getByLabelText('模型名称')).toHaveValue('available-chat');
  fireEvent.change(screen.getByLabelText('连接名称'), { target: { value: 'Local' } });
  fireEvent.click(screen.getByText('保存连接'));
  await screen.findByText('连接已加密保存到本机。');
  expect(store.getState().saveProfile).toHaveBeenCalledWith(expect.objectContaining({ model: 'available-chat' }), '', false);
  expect(vi.mocked(store.getState().saveProfile).mock.calls[0][0].maxTokens).toBeUndefined();
  vi.mocked(store.getState().testProfile).mockImplementation(async id => {
    store.setState(state => ({ profiles: state.profiles.map(profile => profile.id === id ? { ...profile, textTestedAt: '2026-09-30T08:00:00.000Z' } : profile) }));
  });
  fireEvent.click(screen.getByText('测试连接'));
  await screen.findByText(/^文本调用：最近测试通过/);
  fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'other-chat' } });
  expect(screen.getByText('文本调用：未验证')).toBeInTheDocument();
});

it.each(['endpoint', 'cancel', 'unmount', 'account'] as const)('discards late catalogs on %s', async reason => {
  let finish!: (value: ModelCatalog) => void;
  vi.mocked(store.getState().discoverProfileModels).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  localDraft(); fireEvent.click(screen.getByText('获取模型列表'));
  const signal = vi.mocked(store.getState().discoverProfileModels).mock.calls[0][3];
  if (reason === 'endpoint') fireEvent.change(screen.getByLabelText('API Base URL'), { target: { value: 'http://127.0.0.1:1234/v1' } });
  else if (reason === 'cancel') fireEvent.click(screen.getByText('取消请求'));
  else if (reason === 'unmount') cleanup();
  else act(() => useAuthStore.setState({ isAuthenticated: true, user: { id: 2 } as ReturnType<typeof useAuthStore.getState>['user'] }));
  expect(signal.aborted).toBe(true);
  await act(async () => finish({ models: [{ id: 'late-catalog' }], truncated: false }));
  expect(screen.queryByLabelText('从列表选择模型')).not.toBeInTheDocument();
});

it('keeps hand entry and saving available after a failed list request', async () => {
  vi.mocked(store.getState().discoverProfileModels).mockRejectedValue(new Error('列表不可用，可手填'));
  localDraft(); fireEvent.click(screen.getByText('获取模型列表'));
  await screen.findByText('列表不可用，可手填');
  fireEvent.change(screen.getByLabelText('连接名称'), { target: { value: 'Local' } });
  fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'manual' } });
  fireEvent.click(screen.getByText('保存连接'));
  await screen.findByText('连接已加密保存到本机。');
});

it('does not mark a cancelled text probe successful and keeps the saved model', async () => {
  let finish!: () => void;
  vi.mocked(store.getState().testProfile).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  store.setState({ profiles: [{ id: 'saved', name: 'Saved', baseUrl: 'http://127.0.0.1:1234/v1', model: 'chat', hasKey: true, mode: 'local' }] });
  render(<ModelConnections />); fireEvent.click(screen.getByLabelText('编辑 Saved'));
  fireEvent.click(screen.getByText('测试连接'));
  await waitFor(() => expect(finish).toBeDefined());
  fireEvent.click(screen.getByText('取消请求')); await act(async () => finish());
  expect(screen.getByText('文本调用：未验证')).toBeInTheDocument();
  expect(screen.getByLabelText('模型名称')).toHaveValue('chat');
});

it('shows the saved successful-test time only while the edited settings match', () => {
  store.setState({ profiles: [{ id: 'saved', name: 'Saved', baseUrl: 'http://127.0.0.1:1234/v1', model: 'chat', hasKey: true, mode: 'local', textTestedAt: '2026-09-30T08:00:00.000Z' }] });
  render(<ModelConnections />); fireEvent.click(screen.getByLabelText('编辑 Saved'));
  expect(screen.getByText(/^文本调用：最近测试通过/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'changed-chat' } });
  expect(screen.getByText('文本调用：未验证')).toBeInTheDocument();
});

it('shows separately verified tool support and clears it when the edited model changes', async () => {
  store.setState({ profiles: [{ id: 'saved', name: 'Saved', baseUrl: 'http://127.0.0.1:1234/v1', model: 'chat', hasKey: true, mode: 'local', toolTestedAt: '2026-09-30T08:00:00.000Z' }] });
  vi.mocked(store.getState().testProfileToolSupport).mockResolvedValue(undefined);
  render(<ModelConnections />); fireEvent.click(screen.getByLabelText('编辑 Saved'));
  expect(screen.getByText(/^工具调用：最近测试通过/)).toBeInTheDocument();
  fireEvent.click(screen.getByText('测试工具调用'));
  await screen.findByText(/已按 inspect_csv 契约返回工具调用/);
  expect(store.getState().testProfileToolSupport).toHaveBeenCalledWith('saved', expect.any(AbortSignal));
  fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'changed-chat' } });
  expect(screen.getByText(/工具调用：未验证/)).toBeInTheDocument();
  expect(screen.getByText(/不执行工具或发送文件/)).toBeInTheDocument();
});

it('shows explicit unknown statuses for capabilities that have no compatible probe', () => {
  store.setState({ profiles: [{ id: 'saved', name: 'Saved', baseUrl: 'http://127.0.0.1:1234/v1', model: 'chat', hasKey: true, mode: 'local', capabilities: { vision: { state: 'unknown' }, contextWindow: { state: 'unknown' } } }] });
  render(<ModelConnections />); fireEvent.click(screen.getByLabelText('编辑 Saved'));
  expect(screen.getByText(/图片输入：未知（未探测）；上下文长度：未知（未探测）/)).toBeInTheDocument();
  expect(screen.getByText(/最大输出上限：未配置（服务商上限未知）/)).toBeInTheDocument();
});

it('shows only the authorized account model with explicit permission refresh', () => {
  useAuthStore.setState({ isAuthenticated: true, user: { id: 2 } as ReturnType<typeof useAuthStore.getState>['user'] });
  store.setState({ accountModel: { userId: 2, model: 'server-managed' } });
  render(<ModelConnections />);
  expect(screen.getByText('已授权：server-managed')).toBeInTheDocument();
  fireEvent.click(screen.getByText('刷新账号模型'));
  expect(store.getState().refreshAccountModel).toHaveBeenCalledTimes(1);
  expect(store.getState().discoverProfileModels).not.toHaveBeenCalled();
});
