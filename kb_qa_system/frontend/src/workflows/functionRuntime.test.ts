import { expect, it } from 'vitest';
import { evaluateIsolatedFunction } from './functionRuntime';
it('executes plain data without exposing host interfaces', async () => {
  expect(await evaluateIsolatedFunction('return { result: inputs.context.trim(), secure: typeof fetch === "undefined" && typeof process === "undefined" && typeof document === "undefined" && typeof __TAURI__ === "undefined" };', { context:' fixture ' })).toEqual({result:'fixture', secure:true});
});
it('interrupts infinite loops and rejects promises, objects and nonfinite numbers', async () => {
  await expect(evaluateIsolatedFunction('while (true) {}', {})).rejects.toThrow();
  for (const code of ['return Promise.resolve({});','return { result: {} };','return { result: Infinity };','return { result: "x".repeat(100001) };']) await expect(evaluateIsolatedFunction(code, {})).rejects.toThrow();
});
it('isolates guest state on every execution', async () => {
  await evaluateIsolatedFunction('globalThis.secret = 1; return {};',{});
  expect(await evaluateIsolatedFunction('return { absent: typeof secret === "undefined" };',{})).toEqual({absent:true});
});
