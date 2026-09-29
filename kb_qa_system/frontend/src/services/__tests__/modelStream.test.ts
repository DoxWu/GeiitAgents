import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { readModelResponse } from '../modelStream';
const cases: { name: string; wire: string; content?: string; reason?: string }[] = JSON.parse(readFileSync('../test_fixtures/model_text_stream.json', 'utf8'));
const encoder = new TextEncoder();
const signal = () => new AbortController().signal;
function response(chunks: Uint8Array[], type = 'text/event-stream', cancel = vi.fn()) {
  return new Response(new ReadableStream({ start(controller) { chunks.forEach(chunk => controller.enqueue(chunk)); controller.close(); }, cancel }), { headers: { 'content-type': type } });
}
it.each(cases)('uses the cross-language protocol corpus: $name', async value => {
  const bytes = encoder.encode(value.wire);
  for (let split = 0; split <= bytes.length; split++) {
    const promise = readModelResponse(response([bytes.slice(0, split), bytes.slice(split)]), signal());
    if (value.content) expect(await promise).toMatchObject({ content: value.content, finishReason: value.reason });
    else await expect(promise).rejects.toThrow();
  }
});
it('rejects malformed UTF-8, budgets and callback failures, closing the reader', async () => {
  await expect(readModelResponse(response([new Uint8Array([0xff])]), signal())).rejects.toThrow();
  await expect(readModelResponse(response([new Uint8Array(2 * 1024 * 1024 + 1)]), signal())).rejects.toThrow();
  const wire = (content: string) => encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] }) + '\n\n');
  await expect(readModelResponse(response([wire('x'.repeat(1_000_001))]), signal())).rejects.toThrow();
  const cancel = vi.fn();
  const open = new Response(new ReadableStream({ start(controller) { controller.enqueue(wire('text')); }, cancel }), { headers: { 'content-type': 'text/event-stream' } });
  await expect(readModelResponse(open, signal(), () => { throw new Error('callback'); })).rejects.toThrow('callback'); expect(cancel).toHaveBeenCalledOnce();
});
it('returns at the completion marker and closes a still-open response; abort refuses partial text', async () => {
  const cancel = vi.fn();
  const open = () => new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode(cases[0].wire + '\n\n')); }, cancel }), { headers: { 'content-type': 'text/event-stream' } });
  expect((await readModelResponse(open(), signal())).content).toBe('你好🌏'); expect(cancel).toHaveBeenCalledOnce();
  const controller = new AbortController();
  await expect(readModelResponse(open(), controller.signal, () => controller.abort())).rejects.toMatchObject({ name: 'AbortError' });
});
it('accepts JSON fallback once with reason and requires the selected text choice', async () => {
  const chunk = vi.fn();
  const data = JSON.stringify({ choices: [{ index: 1, message: { content: 'ignore' } }, { index: 0, message: { content: '正文' }, finish_reason: 'length' }] });
  expect(await readModelResponse(response([encoder.encode(data)], 'application/json'), signal(), chunk)).toEqual({ content: '正文', finishReason: 'length' });
  expect(chunk).toHaveBeenCalledExactlyOnceWith('正文');
});
it('requires relay done and matching full content, and never swallows relay errors', async () => {
  const chunk = 'data: {"type":"chunk","content":"正文"}\r\n\r\n';
  const done = 'data: {"type":"done",\r\ndata: "content":"正文","finish_reason":"length"}\r\n\r\n';
  expect(await readModelResponse(response([encoder.encode(chunk + done)]), signal(), undefined, true)).toMatchObject({ content: '正文', finishReason: 'length' });
  for (const wire of [chunk, chunk + done.replace('"content":"正文"', '"content":"不同"'), chunk + 'data: {"type":"error","content":"secret"}\n\n', chunk + 'data: broken\n\n']) {
    await expect(readModelResponse(response([encoder.encode(wire)]), signal(), undefined, true)).rejects.toThrow();
  }
});

it('closes rejected HTTP bodies and wrong relay content types without consuming error details', async () => {
  for (const status of [200, 500]) {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { status, headers: { 'content-type': 'application/json' } });
    await expect(readModelResponse(response, signal(), undefined, true)).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
  }
});
