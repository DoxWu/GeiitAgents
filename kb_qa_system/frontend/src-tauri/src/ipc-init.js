// This application sends JSON IPC payloads, including Tauri Channel serializers.
// The native invoke key is installed only in the top window. WebView2 can inject
// initialization scripts into child frames even when marked main-frame-only.
(() => {
  const internals = window.__TAURI_INTERNALS__;
  if (window.top !== window) {
    Object.defineProperty(internals, 'postMessage', { value: message => {
      internals.runCallback(message.error, 'Desktop commands are unavailable in previews');
    } });
    return;
  }
  const invokeKey = __INVOKE_KEY__;
  Object.defineProperty(internals, 'postMessage', { value: message => {
    try {
      window.ipc.postMessage(JSON.stringify({ ...message, __TAURI_INVOKE_KEY__: invokeKey }, (_key, value) => {
        if (value && typeof value.__TAURI_TO_IPC_KEY__ === 'function') return value.__TAURI_TO_IPC_KEY__();
        if (ArrayBuffer.isView(value)) return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
        if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
        return value;
      }));
    } catch {
      internals.runCallback(message.error, 'Desktop command could not be sent');
    }
  } });
})();
