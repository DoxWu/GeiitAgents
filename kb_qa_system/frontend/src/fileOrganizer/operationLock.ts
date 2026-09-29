// Shared by rename/move/undo and bounded text access. Keep this small so text
// editing does not eagerly import the otherwise lazy move/compensation engine.
let running = false;
export async function exclusively<T>(operation: () => Promise<T>): Promise<T> {
  const execute = async (): Promise<T> => {
    if (running) throw new Error('已有文件操作正在运行，请稍后再试。');
    running = true;
    try { return await operation(); }
    finally { running = false; }
  };
  if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request('geiit-file-organizer', { ifAvailable: true }, lock => {
    if (!lock) throw new Error('其他窗口正在操作文件，请稍后再试。');
    return execute();
  });
  return execute();
}
