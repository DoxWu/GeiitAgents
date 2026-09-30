import { expect, it } from 'vitest';
import { readMarkdownNote } from './markdownImport';

function invalidUtf8File() {
  return new File([new Uint8Array([0xc3, 0x28])], 'invalid.md', { type: 'text/markdown' });
}

it('reads a bounded UTF-8 Markdown file as a validated note input', async () => {
  const input = await readMarkdownNote(new File(['\uFEFF# Weekly notes\n\nKeep this Markdown.'], 'Weekly notes.MD'));
  expect(input).toEqual({ kind: 'note', title: 'Weekly notes', content: '# Weekly notes\n\nKeep this Markdown.', tags: [] });
});

it('rejects unsupported names, malformed UTF-8 and inputs beyond note limits', async () => {
  await expect(readMarkdownNote(new File(['text'], 'notes.txt'))).rejects.toThrow('.md');
  await expect(readMarkdownNote(invalidUtf8File())).rejects.toThrow('UTF-8');
  await expect(readMarkdownNote(new File(['x'.repeat(20_001)], 'large.md'))).rejects.toThrow('20000');
  await expect(readMarkdownNote(new File(['x'.repeat(80_001)], 'large.md'))).rejects.toThrow('80 KB');
  await expect(readMarkdownNote(new File(['body'], ' '.repeat(121) + '.md'))).rejects.toThrow('标题');
});
