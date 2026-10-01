import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LocalKnowledgePage from '../LocalKnowledgePage';
import { DEFAULT_PROFILE, fingerprint, type LocalIndex } from '@/localKnowledge/core';
const mock = vi.hoisted(() => ({ init: vi.fn(), build: vi.fn(), query: vi.fn(), stop: vi.fn(), create: vi.fn(), load: vi.fn(), commit: vi.fn(), read: vi.fn() }));
vi.mock('@/localKnowledge/documentImport', () => ({ readLocalDocument: mock.read }));
vi.mock('@/localKnowledge/client', () => ({ LocalEmbeddingClient: class {
  constructor() { mock.create(); }
  init = mock.init; build = mock.build; query = mock.query; stop = mock.stop;
} }));
vi.mock('@/localKnowledge/storage', () => ({ loadIndex: mock.load, commitIndex: mock.commit, MODEL_CACHE: 'test-models', SESSION_LOCK: 'test-lock' }));
const original: LocalIndex = { version: 1, revision: 'old', profile: DEFAULT_PROFILE, fingerprint: fingerprint(DEFAULT_PROFILE),
  documents: [{ id: 'doc', name: 'private.txt', text: 'private content', bytes: 15 }], chunks: [], updatedAt: '' };
function mount() { return render(<MemoryRouter><LocalKnowledgePage /></MemoryRouter>); }
async function enable() { const button = screen.getByRole('button', { name: '启用模型 / 按配置重建' }); await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button); }
beforeEach(() => {
  vi.clearAllMocks(); mock.load.mockResolvedValue(null); mock.init.mockResolvedValue(undefined); mock.commit.mockResolvedValue(undefined);
  mock.build.mockResolvedValue({ ...original, documents: [], revision: 'empty' });
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: vi.fn(async (_name, _options, callback) => callback({ name: 'test' })) } });
});
afterEach(cleanup);
describe('local knowledge opt-in UI', () => {
  it('does not start a model before an explicit click and keeps cloud navigation separate', async () => {
    mount(); await waitFor(() => expect(screen.getByRole('button', { name: '启用模型 / 按配置重建' })).toBeEnabled());
    expect(mock.create).not.toHaveBeenCalled(); expect(mock.init).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: '云端知识库 ↗' })).toHaveAttribute('href', '/documents');
    await enable(); await waitFor(() => expect(mock.init).toHaveBeenCalledWith(DEFAULT_PROFILE));
    expect(await screen.findByText('本地 CPU 模型已就绪')).toBeInTheDocument();
  });
  it('ignores a late initialization completion after cancellation', async () => {
    let finish!: () => void;
    mock.init.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    mount(); await enable();
    await waitFor(() => expect(mock.create).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '取消并关闭模型' })); finish();
    await waitFor(() => expect(mock.stop).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: '选择文件并建立索引' })).toBeDisabled();
    expect(mock.commit).not.toHaveBeenCalled();
  });
  it('preserves old index when a model rebuild fails', async () => {
    mock.load.mockResolvedValue(original); mock.build.mockRejectedValue(new Error('模型不兼容'));
    mount(); await waitFor(() => expect(screen.getByText('private.txt')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '自定义兼容 ONNX 模型' }));
    fireEvent.change(screen.getByLabelText('本地向量模型配置（JSON）'), { target: { value: JSON.stringify({ ...DEFAULT_PROFILE, pooling: 'cls' }) } });
    await enable();
    expect(await screen.findByRole('alert')).toHaveTextContent('模型不兼容');
    expect(mock.commit).not.toHaveBeenCalled(); expect(screen.getByText('private.txt')).toBeInTheDocument();
  });
  it('atomically switches only after successful rebuild', async () => {
    const updated = { ...original, revision: 'new' }; mock.load.mockResolvedValue(original); mock.build.mockResolvedValue(updated);
    mount(); await waitFor(() => expect(screen.getByText('private.txt')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '自定义兼容 ONNX 模型' }));
    fireEvent.change(screen.getByLabelText('本地向量模型配置（JSON）'), { target: { value: JSON.stringify({ ...DEFAULT_PROFILE, queryPrefix: '' }) } });
    await enable(); await waitFor(() => expect(mock.commit).toHaveBeenCalledWith(updated, 'old'));
  });
  it('imports by extracted text size and retains omission warnings after reload', async () => {
    mock.load.mockResolvedValue(original); mount(); await enable();
    await screen.findByText('本地 CPU 模型已就绪');
    const doc = { id: 'pdf', name: '报销.pdf', text: '报销需发票', bytes: 15, importWarnings: ['图片不会保留'] };
    mock.read.mockResolvedValue(doc); mock.build.mockResolvedValue({ ...original, documents: [...original.documents, doc], revision: 'new' });
    fireEvent.change(screen.getByLabelText('选择本地文档'), { target: { files: [{ name: '报销.pdf', size: 10_000_000 }, { name: '另一份.pdf', size: 10_000_000 }] } });
    await waitFor(() => expect(mock.commit).toHaveBeenCalledWith(expect.objectContaining({ revision: 'new' }), 'old'));
    expect(screen.getByText('图片不会保留')).toBeInTheDocument();
    cleanup(); mock.load.mockResolvedValue({ ...original, documents: [doc] }); mount();
    expect(await screen.findByText('图片不会保留')).toBeInTheDocument();
    expect(mock.init).toHaveBeenCalledTimes(1);
  });
  it('preserves the original index when a later file fails to parse', async () => {
    mock.load.mockResolvedValue(original); mount(); await enable(); await screen.findByText('本地 CPU 模型已就绪');
    mock.read.mockResolvedValueOnce({ ...original.documents[0], id: 'new' }).mockRejectedValueOnce(new Error('PDF 受密码保护'));
    fireEvent.change(screen.getByLabelText('选择本地文档'), { target: { files: [new File(['x'], 'ok.txt'), new File(['x'], 'locked.pdf')] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('密码保护');
    expect(mock.build).not.toHaveBeenCalled(); expect(mock.commit).not.toHaveBeenCalled();
    expect(screen.getByText('private.txt')).toBeInTheDocument();
  });
  it('stops a cancelled batch before the next file and ignores late parser completion', async () => {
    mock.load.mockResolvedValue(original); mount(); await enable(); await screen.findByText('本地 CPU 模型已就绪');
    let finish!: (value: typeof original.documents[0]) => void;
    mock.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    fireEvent.change(screen.getByLabelText('选择本地文档'), { target: { files: [new File(['x'], 'a.pdf'), new File(['x'], 'b.pdf')] } });
    await waitFor(() => expect(mock.read).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '取消并关闭模型' })); finish(original.documents[0]);
    await waitFor(() => expect(mock.stop).toHaveBeenCalled());
    expect(mock.read).toHaveBeenCalledTimes(1); expect(mock.build).not.toHaveBeenCalled(); expect(mock.commit).not.toHaveBeenCalled();
  });
  it('rejects excessive extracted text before starting the index build', async () => {
    const documents = Array.from({ length: 5 }, (_, n) => ({ ...original.documents[0], id: `d${n}`, bytes: 2 * 1024 * 1024 }));
    mock.load.mockResolvedValue({ ...original, documents }); mount(); await enable(); await screen.findByText('本地 CPU 模型已就绪');
    mock.read.mockResolvedValue({ id: 'new', name: 'new.pdf', text: 'extra', bytes: 5 });
    fireEvent.change(screen.getByLabelText('选择本地文档'), { target: { files: [new File(['x'], 'new.pdf')] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('提取文本合计超过 10 MiB');
    expect(mock.build).not.toHaveBeenCalled(); expect(mock.commit).not.toHaveBeenCalled();
  });
});
