import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { DEFAULT_PROFILE } from '@/localKnowledge/core';
import EmbeddingProfileForm from '../EmbeddingProfileForm';

afterEach(cleanup);
function Form({ disabled = false }: { disabled?: boolean }) {
  const [draft, setDraft] = useState(JSON.stringify(DEFAULT_PROFILE));
  return <EmbeddingProfileForm draft={draft} onChange={setDraft} disabled={disabled} />;
}
it('synchronizes form and JSON while preserving significant prefix whitespace', () => {
  render(<Form />);
  fireEvent.change(screen.getByLabelText(/^检索问题前缀/), { target: { value: 'custom:  ' } });
  const json = screen.getByLabelText('本地向量模型配置（JSON）') as HTMLTextAreaElement;
  expect(JSON.parse(json.value).queryPrefix).toBe('custom:  ');
  fireEvent.change(json, { target: { value: JSON.stringify({ ...DEFAULT_PROFILE, dimensions: 768 }) } });
  expect(screen.getByLabelText('向量维度')).toHaveValue(768);
  fireEvent.change(screen.getByLabelText(/^固定版本 commit/), { target: { value: 'main' } });
  expect(screen.getByRole('alert')).toHaveTextContent('配置尚未有效');
});
it('allows repairing invalid JSON and disables all edits during model use', () => {
  const view = render(<Form />);
  fireEvent.change(screen.getByLabelText('本地向量模型配置（JSON）'), { target: { value: '{' } });
  expect(screen.getByRole('alert')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('本地向量模型配置（JSON）'), { target: { value: JSON.stringify(DEFAULT_PROFILE) } });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  view.rerender(<Form disabled />);
  expect(screen.getByLabelText('向量维度')).toBeDisabled();
  expect(screen.getByLabelText('本地向量模型配置（JSON）')).toBeDisabled();
});
