import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const script = (await readFile(new URL('../src-tauri/src/ipc-init.js', import.meta.url), 'utf8'))
  .replace('__INVOKE_KEY__', '"synthetic-runtime-key"');
function fixture(child = false) {
  const sent = [], callbacks = [];
  const window = { __TAURI_INTERNALS__: { runCallback: (...args) => callbacks.push(args) }, ipc: { postMessage: text => sent.push(JSON.parse(text)) } };
  window.top = child ? {} : window;
  const context = vm.createContext({ window });
  vm.runInContext(script, context);
  return { window, sent, callbacks, context };
}
test('top-level JSON IPC preserves channels, unicode, typed bytes and callbacks', () => {
  const { window, sent, context } = fixture();
  vm.runInContext(`window.__TAURI_INTERNALS__.postMessage({cmd:'stream_local_model',callback:10,error:11,payload:{text:'中文🌏',channel:{__TAURI_TO_IPC_KEY__:()=> '__CHANNEL__:12'},bytes:new Uint8Array([0,127,255])}})`, context);
  assert.deepEqual(sent, [{ cmd: 'stream_local_model', callback: 10, error: 11, payload: { text: '中文🌏', channel: '__CHANNEL__:12', bytes: [0, 127, 255] }, __TAURI_INVOKE_KEY__: 'synthetic-runtime-key' }]);
  assert.equal(String(window.__TAURI_INTERNALS__.postMessage).includes('synthetic-runtime-key'), false);
});
test('child frames reject every command before a native transport or key is used', () => {
  const { window, sent, callbacks } = fixture(true);
  for (const cmd of ['cancel_local_model', 'organizer_pick_directory', 'plugin:window|close'])
    window.__TAURI_INTERNALS__.postMessage({ cmd, callback: 1, error: 2, payload: {} });
  assert.equal(sent.length, 0);
  assert.equal(callbacks.length, 3);
  assert.ok(callbacks.every(([id, message]) => id === 2 && message.includes('unavailable in previews')));
  assert.equal(String(window.__TAURI_INTERNALS__.postMessage).includes('invokeKey'), false);
});
test('serialization or native transport failure rejects without leaking request data', () => {
  const { window, callbacks } = fixture();
  window.ipc.postMessage = () => { throw new Error('synthetic-private-key'); };
  window.__TAURI_INTERNALS__.postMessage({ cmd: 'test', callback: 5, error: 6, payload: {} });
  assert.deepEqual(callbacks, [[6, 'Desktop command could not be sent']]);
});
