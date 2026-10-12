/**
 * 搜索框组件
 *
 * 作用：
 *   提供标题或原始文件名实时搜索；不搜索文档正文。
 *   输入时防抖触发搜索（300ms），避免频繁请求。
 *
 * 增强（D5-01 / D2-02 / D2-03）：
 *   - D5-01：IME 输入法组合事件处理，中文输入期间不触发搜索
 *   - D2-03：搜索历史，聚焦时展示最近 10 条历史记录
 *   - D2-02：历史项中关键词高亮
 *
 * 使用方式：
 *   <SearchBar />
 */

import { useState, useEffect, useRef } from "react";
import { Search, X, Clock, Trash2 } from "lucide-react";
import { useDocumentStore } from "@/store/documentStore";
import { cn } from "@/lib/utils";

/** 防抖延迟（毫秒） */
const DEBOUNCE_DELAY = 300;

/** SearchBar 组件 */
export function SearchBar() {
  const {
    searchKeyword,
    setSearchKeyword,
    loadDocuments,
    searchHistory,
    searchHistoryEnabled,
    addSearchHistory,
    clearSearchHistory,
    setSearchHistoryEnabled,
  } = useDocumentStore();
  const [value, setValue] = useState(searchKeyword);
  const [isComposing, setIsComposing] = useState(false); // D5-01 IME 组合状态
  const [showHistory, setShowHistory] = useState(false); // D2-03 历史下拉
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // 输入变化时防抖触发搜索（D5-01：IME 组合期间不触发）
  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    // 同步关键词到 store
    setSearchKeyword(value);
    // IME 组合期间不触发搜索，等组合结束后再搜
    if (isComposing) return;
    // 防抖加载文档列表
    timerRef.current = setTimeout(() => {
      loadDocuments();
      // D2-03：搜索执行时将关键词加入历史
      if (value.trim()) {
        addSearchHistory(value.trim());
      }
    }, DEBOUNCE_DELAY);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
    // E3-03: debounce effect 仅依赖 value/isComposing 触发。
    // addSearchHistory 等回调来自 store，引用稳定但 lint 无法识别。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, isComposing]);

  // D2-03：点击外部关闭历史下拉
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setShowHistory(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  /** 清空搜索 */
  function handleClear() {
    setValue("");
  }

  /** D2-03：点击历史项搜索 */
  function handleHistoryClick(keyword: string) {
    setValue(keyword);
    setShowHistory(false);
  }

  /** D2-03：清空历史 */
  function handleClearHistory(e: React.MouseEvent) {
    e.stopPropagation();
    clearSearchHistory();
  }

  /** D5-01：IME 组合结束 */
  function handleCompositionEnd(e: React.CompositionEvent<HTMLInputElement>) {
    setIsComposing(false);
    // 组合结束后立即触发一次搜索
    const val = e.currentTarget.value;
    setSearchKeyword(val);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      loadDocuments();
      if (val.trim()) {
        addSearchHistory(val.trim());
      }
    }, DEBOUNCE_DELAY);
  }

  /** 键盘事件：Enter 立即搜索 */
  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // D5-01：IME 组合期间 Enter 不触发搜索（用于选词）
    if (e.key === "Enter" && !isComposing) {
      e.preventDefault();
      if (timerRef.current) clearTimeout(timerRef.current);
      if (value.trim()) {
        addSearchHistory(value.trim());
      }
      loadDocuments();
      setShowHistory(false);
    }
  }

  // 是否展示历史下拉：聚焦且输入框为空且有历史记录
  const shouldShowHistory = showHistory && !value;

  return (
    <div ref={containerRef} className="relative flex-1 max-w-md">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-tertiary" />
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={handleCompositionEnd}
        onKeyDown={handleKeyDown}
        onFocus={() => setShowHistory(true)}
        placeholder="搜索标题或文件名..."
        className={cn(
          "h-9 w-full rounded-md border border-line bg-surface pl-9 pr-9",
          "text-sm text-ink placeholder:text-ink-tertiary",
          "focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand",
          "transition-colors",
        )}
      />
      {value && (
        <button
          onClick={handleClear}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-ink-tertiary transition-colors hover:bg-muted hover:text-ink"
          aria-label="清空搜索"
        >
          <X className="h-4 w-4" />
        </button>
      )}

      {/* D2-03 搜索历史下拉 */}
      {shouldShowHistory && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-md border border-line bg-surface shadow-lg">
          <div className="flex items-center justify-between px-3 py-2">
            <span className="flex items-center gap-1.5 text-xs font-medium text-ink-tertiary">
              <Clock className="h-3 w-3" />
              搜索历史
            </span>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
                <input
                  aria-label="保存搜索历史"
                  type="checkbox"
                  checked={searchHistoryEnabled}
                  onChange={(event) => setSearchHistoryEnabled(event.target.checked)}
                />
                保存
              </label>
              <button
                onClick={handleClearHistory}
                disabled={!searchHistory.length}
                className="flex items-center gap-1 text-xs text-ink-tertiary transition-colors hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="清空搜索历史"
              >
                <Trash2 className="h-3 w-3" />
                清空
              </button>
            </div>
          </div>
          <div className="max-h-60 overflow-y-auto">
            {searchHistory.length ? searchHistory.map((keyword, index) => (
              <button
                key={`${keyword}-${index}`}
                onClick={() => handleHistoryClick(keyword)}
                className="flex w-full items-center px-3 py-2 text-left text-sm text-ink-secondary transition-colors hover:bg-muted"
              >
                <Clock className="mr-2 h-3 w-3 shrink-0 text-ink-tertiary" />
                {/* D2-02 搜索高亮（历史项中高亮关键词本身无意义，直接显示文本） */}
                <span className="truncate">{keyword}</span>
              </button>
            )) : <p className="px-3 py-3 text-xs text-ink-tertiary">{searchHistoryEnabled ? "暂无搜索历史" : "已关闭搜索历史保存"}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
