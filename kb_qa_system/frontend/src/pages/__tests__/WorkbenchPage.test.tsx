import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import WorkbenchPage from '../WorkbenchPage';
import { useWorkbenchStore as store } from '@/store/workbenchStore';
import type { WorkConversation, WorkMessage } from '@/types/workbench';

function conversation(id: string, title: string, count: number): WorkConversation {
  const messages: WorkMessage[] = Array.from({ length: count }, (_, index) => ({
    id: `${id}-${index}`, role: index % 2 ? 'assistant' : 'user', content: `${id}-message-${index}`,
    createdAt: new Date(index * 1000).toISOString(),
  }));
  return { id, title, profileId: 'missing-model', messages, updatedAt: new Date().toISOString() };
}

beforeEach(() => {
  store.setState({ unlocked: true, currentId: 'long', conversations: [conversation('long', '长对话', 45), conversation('second', '第二条', 30)], profiles: [], accountModel: null });
});
afterEach(() => {
  cleanup();
  store.setState({ unlocked: false, currentId: null, conversations: [], profiles: [], accountModel: null });
});

it('renders recent chat messages first, loads older pages without dropping them, and resets on conversation switch', async () => {
  render(<MemoryRouter><WorkbenchPage /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText('long-message-25')).toBeInTheDocument());
  expect(screen.getByText('long-message-25')).toBeInTheDocument();
  expect(screen.queryByText('long-message-24')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '加载更早的消息' }));
  expect(screen.getByText('long-message-5')).toBeInTheDocument();
  expect(screen.queryByText('long-message-4')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '加载更早的消息' }));
  expect(screen.getByText('long-message-0')).toBeInTheDocument();
  expect(screen.getByText('long-message-44')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: '第二条' }));
  expect(screen.queryByText('second-message-9')).not.toBeInTheDocument();
  expect(screen.getByText('second-message-29')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '加载更早的消息' })).toBeInTheDocument();
});
