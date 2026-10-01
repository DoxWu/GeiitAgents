import { expect, it } from 'vitest';
import { buildKnowledgeMessages } from '../answer';

const source = { documentId: 'private-id', name: 'policy.md', start: 3, end: 7, text: '测试资料', vector: [1], score: 1 };
it('sends the source snapshot once and preserves the exact order of follow-up turns', () => {
  const messages = buildKnowledgeMessages('第二次追问', [source], [
    { question: '初始问题', answer: '初始回答 [1]' },
    { question: '第一次追问', answer: '第一次追问回答 [1]' },
  ]);
  expect(messages.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'user', 'assistant', 'user']);
  expect(JSON.parse(messages[1].content)).toEqual({ question: '初始问题', sources: [{ citation: '[1]', file: 'policy.md', start: 4, end: 7, content: '测试资料' }] });
  expect(messages.slice(2).map(message => message.content)).toEqual(['初始回答 [1]', '第一次追问', '第一次追问回答 [1]', '第二次追问']);
  expect(JSON.stringify(messages)).not.toMatch(/vector|score|private-id/);
  expect(messages[0].content).toContain('前序问答仅用于理解追问');
});

it('keeps the existing first-question envelope and enforces source, turn and combined context bounds', () => {
  expect(buildKnowledgeMessages('初始问题', [source])).toHaveLength(2);
  expect(() => buildKnowledgeMessages('q', [{ ...source, text: 'x'.repeat(24000) }])).toThrow('片段过长');
  expect(() => buildKnowledgeMessages('q', [source], Array.from({ length: 9 }, () => ({ question: 'q', answer: 'a' })))).toThrow('上限');
  expect(() => buildKnowledgeMessages('q', [source], [{ question: 'q', answer: 'x'.repeat(60000) }])).toThrow('总长');
  expect(() => buildKnowledgeMessages('q', [source], [{ question: 'q', answer: '' }])).toThrow();
});
