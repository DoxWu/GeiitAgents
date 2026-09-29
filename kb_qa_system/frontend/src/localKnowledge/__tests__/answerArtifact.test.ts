import { expect, it } from 'vitest';
import { answerMarkdown, createAnswerArtifact } from '../answerArtifact';

it('captures an independent source snapshot without vectors or provider credentials', () => {
  const source = { documentId: 'private-id', name: 'policy.md', start: 3, end: 7, text: '测试资料', vector: [1], score: 1 };
  const answer = createAnswerArtifact('问题', { content: '回答 [1]', model: 'model' }, [source]);
  source.text = 'changed';
  expect(answer.sources).toEqual([{ name: 'policy.md', start: 3, end: 7, text: '测试资料' }]);
  const markdown = answerMarkdown(answer);
  expect(markdown).toContain('字符 4–7');
  expect(markdown).toContain('回答 [1]');
  expect(markdown).not.toContain('private-id');
  expect(JSON.stringify(answer)).not.toMatch(/vector|score|apiKey|baseUrl/);
});

it('keeps a reported output limit in the source snapshot and exported answer', () => {
  const answer = createAnswerArtifact('问题', { content: '部分回答 [1]', model: 'model', finishReason: 'length' }, [
    { documentId: 'd', name: 'policy.md', start: 0, end: 4, text: '测试资料', vector: [], score: 1 },
  ]);
  expect(answer.finishReason).toBe('length'); expect(answerMarkdown(answer)).toContain('已达到模型输出上限，回答可能不完整');
});

it('keeps hostile Markdown and embedded fences literal inside source snapshots', () => {
  const text = '```\n<script>alert(1)</script>\n````\n![image](https://example.test/pixel)';
  const answer = createAnswerArtifact('question', { content: 'answer', model: 'model' }, [
    { documentId: 'd', name: '![file](https://example.test/pixel)', start: 0, end: text.length, text, vector: [], score: 1 },
  ]);
  expect(answerMarkdown(answer)).toContain('`````text\n' + text + '\n`````');
  expect(answerMarkdown(answer)).toContain('```text\n![file](https://example.test/pixel)\n```');
});
