import type { SearchHit } from './core';
import { buildKnowledgeMessages, type KnowledgeTurn } from './answer';
import { finishLabel, type FinishReason } from '@/services/modelStream';

export interface KnowledgeAnswerArtifact {
  id: string;
  createdAt: string;
  question: string;
  content: string;
  model: string;
  finishReason?: FinishReason;
  history?: KnowledgeAnswerTurn[];
  sources: { name: string; start: number; end: number; text: string }[];
}

export interface KnowledgeAnswerTurn {
  question: string;
  content: string;
  model: string;
  finishReason?: FinishReason;
}

export function createAnswerArtifact(question: string, result: { content: string; model: string; finishReason?: FinishReason }, sources: SearchHit[], history: KnowledgeAnswerTurn[] = []): KnowledgeAnswerArtifact {
  buildKnowledgeMessages(question, sources, history.map(({ question: turnQuestion, content }) => ({ question: turnQuestion, answer: content } satisfies KnowledgeTurn)));
  return { id: crypto.randomUUID(), createdAt: new Date().toISOString(), question, content: result.content, model: result.model, ...(result.finishReason ? { finishReason: result.finishReason } : {}), ...(history.length ? { history: history.map(turn => ({ ...turn })) } : {}),
    sources: sources.map(({ name, start, end, text }) => ({ name, start, end, text })) };
}

// Source text is always literal, including embedded fences, HTML and Markdown links.
function literal(text: string): string {
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), match => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

export function answerMarkdown(answer: KnowledgeAnswerArtifact): string {
  const history = answer.history?.length ? `## 前序问答\n\n${answer.history.map((turn, index) => `### 第 ${index + 1} 轮\n\n问题：\n\n${literal(turn.question)}\n\n生成模型：\n\n${literal(turn.model)}\n\n${turn.finishReason ? `生成状态：${finishLabel(turn.finishReason)}\n\n` : ''}回答：\n\n${turn.content}`).join('\n\n')}` : '';
  return `# 本地知识库回答\n\n生成时间：${answer.createdAt}\n\n${history ? `${history}\n\n` : ''}## 问题\n\n${literal(answer.question)}\n\n## 生成模型\n\n${literal(answer.model)}\n\n${answer.finishReason ? `生成状态：${finishLabel(answer.finishReason)}\n\n` : ''}## 回答\n\n${answer.content}\n\n## 来源快照\n\n来源为生成时的所选片段，字符位置从 1 开始，按 UTF-16 计数。请核对模型引用。\n\n` +
    answer.sources.map((source, i) => `### [${i + 1}]\n\n文件名：\n\n${literal(source.name)}\n\n字符 ${source.start + 1}–${source.end}\n\n${literal(source.text)}`).join('\n\n') + '\n';
}

export function downloadAnswer(answer: KnowledgeAnswerArtifact): void {
  const url = URL.createObjectURL(new Blob([answerMarkdown(answer)], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = `knowledge-answer-${answer.id}.md`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
