import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { agentMessages, newAgent, validateAgent, validateAgentOutput } from './definition';
import { copyPublicAgent } from '@/api/agents';

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());

it('validates agent inputs and only accepts exact typed output fields', () => {
  const agent = newAgent(); agent.instructions = 'Summarize the input.';
  const messages = agentMessages(agent, { context: 'fixture' });
  expect(messages[0].content).toContain('只输出一个 JSON 对象');
  expect(JSON.parse(messages[1].content as string).inputs).toEqual({ context: 'fixture' });
  expect(validateAgentOutput('{"result":"done"}', agent)).toEqual({ result: 'done' });
  expect(() => validateAgentOutput('{"result":3}', agent)).toThrow('类型契约');
  expect(() => validateAgentOutput('{"result":"ok","private":"x"}', agent)).toThrow('未定义');
  expect(() => validateAgent({ ...agent, extra: true })).toThrow('无效');
});

it('copies public agents as private definitions without inheriting publication rights', () => {
  const source = newAgent(); source.name = 'Public'; source.instructions = 'Review';
  const copy = copyPublicAgent({ id: crypto.randomUUID(), ownerName: 'owner', agent: source, createdAt: '', updatedAt: '' });
  expect(copy.id).not.toBe(source.id);
  expect(copy.sharedId).toBeUndefined();
});
