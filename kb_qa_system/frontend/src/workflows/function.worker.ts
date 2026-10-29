/// <reference lib="webworker" />
import { evaluateIsolatedFunction } from './functionRuntime';
import { newQuickJSWASMModule, newVariant, RELEASE_SYNC } from 'quickjs-emscripten';
import wasmLocation from '@jitl/quickjs-wasmfile-release-sync/wasm?url';
// Let Vite emit the binary beside the worker, including in offline desktop builds.
const engine = newQuickJSWASMModule(newVariant(RELEASE_SYNC, { wasmLocation }));
self.onmessage = async event => {
  try { self.postMessage({ value: await evaluateIsolatedFunction(event.data.code, event.data.inputs, await engine) }); }
  catch (reason) { self.postMessage({ error: reason instanceof Error ? reason.message : '函数执行失败。' }); }
};
