export function TaskNavigation({ hasTask, onResult, onInput, inputLabel = '任务设置 / 新建任务' }: {
  hasTask: boolean; onResult: () => void; onInput: () => void; inputLabel?: string;
}) {
  return <nav aria-label="任务区域导航" className="sticky top-0 z-10 flex flex-wrap gap-2 border-b border-line bg-surface py-3">
    <button type="button" className="work-command" disabled={!hasTask} onClick={onResult}>过程与成果</button>
    <button type="button" className="work-command" onClick={onInput}>{inputLabel}</button>
  </nav>;
}
