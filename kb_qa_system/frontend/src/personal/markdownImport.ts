import { validatePersonalInput, type PersonalInput } from './items';

const MAX_MARKDOWN_BYTES = 80_000;

export async function readMarkdownNote(file: File): Promise<PersonalInput> {
  if (!/\.(?:md|markdown)$/i.test(file.name)) throw new Error('请选择 .md 或 .markdown 文件。');
  if (file.size > MAX_MARKDOWN_BYTES) throw new Error('Markdown 文件不能超过 80 KB。');

  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    throw new Error('Markdown 文件必须是有效的 UTF-8 文本。');
  }
  if (content.length > 20_000) throw new Error('笔记内容不能超过 20000 个字符。');
  const title = file.name.replace(/\.(?:md|markdown)$/i, '').trim();
  return validatePersonalInput({ kind: 'note', title, content, tags: [] });
}
