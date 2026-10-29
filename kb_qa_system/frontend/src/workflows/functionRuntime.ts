import { getQuickJS, type QuickJSWASMModule } from 'quickjs-emscripten';

/** No DOM, fetch, timers, file system, Node or Tauri bindings are installed. */
export async function evaluateIsolatedFunction(code: string, inputs: Record<string, string | number | boolean>, module?: QuickJSWASMModule): Promise<unknown> {
  if (code.length > 20000 || JSON.stringify(inputs).length > 100000) throw new Error('函数代码或输入超限。');
  const QuickJS = module ?? await getQuickJS(), runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(16 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + 1000;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const vm = runtime.newContext();
  try {
    const source = `"use strict"; const inputs = ${JSON.stringify(inputs)};
      const output = (function(inputs) { "use strict";\n${code}\n})(inputs);
      if (!output || typeof output !== 'object' || Array.isArray(output) || typeof output.then === 'function') throw new Error('函数必须同步返回字段对象');
      for (const value of Object.values(output)) if (!['string','number','boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) throw new Error('函数只能返回有限数字、字符串和布尔字段');
      const result = JSON.stringify(output); if (typeof result !== 'string' || result.length > 100000) throw new Error('函数输出超过100000字符'); result;`;
    const result = vm.evalCode(source, 'user-function.js');
    if ('error' in result) { const error = vm.dump(result.error); result.error.dispose(); throw new Error(typeof error?.message === 'string' ? error.message : '函数运行失败或超出资源限制。'); }
    try { return JSON.parse(vm.getString(result.value)); } finally { result.value.dispose(); }
  } finally { vm.dispose(); runtime.dispose(); }
}
