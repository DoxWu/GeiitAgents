import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ArtifactComparison } from '../ArtifactComparison';
import type { WorkArtifact } from '@/types/workbench';

function artifact(id: string, version: number, content: string, parentArtifactId?: string): WorkArtifact {
  return { id, version, content, parentArtifactId, taskId: 'task', kind: 'markdown', name: 'sample.md', mimeType: 'text/markdown', sha256: 'fixture', createdAt: '2026-09-23' };
}
it('shows directional line changes as inert text and allows changing the baseline', () => {
  const one = artifact('one', 1, '# 原文\n旧内容\n'), two = artifact('two', 2, '# 原文\n<img src="https://example.test/track">\n', one.id);
  const three = artifact('three', 3, two.content, two.id);
  const { container } = render(<ArtifactComparison versions={[three, two, one]} target={two} />);
  expect(screen.getByLabelText('对比基准')).toHaveValue('one');
  expect(screen.getByText(/新增 1 行 · 删除 1 行/)).toBeInTheDocument();
  expect(screen.getByText('<img src="https://example.test/track">')).toBeInTheDocument();
  expect(container.querySelector('img, a, script')).toBeNull();
  expect(within(screen.getByLabelText('差异行')).queryByText('# 原文')).toBeNull();
  fireEvent.click(screen.getByLabelText('显示未变化行'));
  expect(within(screen.getByLabelText('差异行')).getByText('# 原文')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('对比基准'), { target: { value: 'three' } });
  expect(screen.getByText('两个版本内容完全相同。')).toBeInTheDocument();
});
it('paginates a large replacement and explicitly bounds displayed long lines', () => {
  const one = artifact('one', 1, 'old\n'), two = artifact('two', 2, Array.from({ length: 210 }, (_, index) => `new-${index}\n`).join('') + 'x'.repeat(2001), one.id);
  render(<ArtifactComparison versions={[two, one]} target={two} />);
  expect(screen.getByText('第 1 / 3 页')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '上一页差异' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '下一页差异' }));
  expect(screen.getByText('第 2 / 3 页')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '下一页差异' }));
  expect(screen.getByText(/此行仅显示前 2000 字符/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '下一页差异' })).toBeDisabled();
});
it('explains limits rather than presenting oversized different texts as equal', () => {
  const one = artifact('one', 1, 'a'.repeat(400000)), two = artifact('two', 2, 'b', one.id);
  render(<ArtifactComparison versions={[two, one]} target={two} />);
  expect(screen.getByText(/两个版本内容不同；合计超过/)).toBeInTheDocument();
  expect(screen.queryByLabelText('差异行')).toBeNull();
});
