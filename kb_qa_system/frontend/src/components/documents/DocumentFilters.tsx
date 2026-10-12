import { RotateCcw } from "lucide-react";
import { SUPPORTED_FILE_TYPES } from "@/utils/constants";
import { useDocumentStore } from "@/store/documentStore";
import type { DocumentStatus } from "@/types/document";

const STATUS_OPTIONS: Array<{ value: DocumentStatus | ""; label: string }> = [
  { value: "", label: "全部状态" },
  { value: "pending", label: "等待处理" },
  { value: "processing", label: "处理中" },
  { value: "completed", label: "已完成" },
  { value: "failed", label: "处理失败" },
  { value: "low_quality", label: "低质量" },
];

const EMPTY_FILTERS = { status: "" as const, file_type: "", date_from: "", date_to: "" };

export function DocumentFilters() {
  const { documentFilters, setDocumentFilters } = useDocumentStore();
  const hasFilters = Object.values(documentFilters).some(Boolean);

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1 text-xs text-ink-secondary">
        <span>状态</span>
        <select
          aria-label="按状态筛选"
          className="h-9 min-w-28 rounded-md border border-line bg-surface px-2 text-sm text-ink"
          value={documentFilters.status}
          onChange={(event) => setDocumentFilters({ status: event.target.value as DocumentStatus | "" })}
        >
          {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-ink-secondary">
        <span>文件类型</span>
        <select
          aria-label="按文件类型筛选"
          className="h-9 min-w-28 rounded-md border border-line bg-surface px-2 text-sm text-ink"
          value={documentFilters.file_type}
          onChange={(event) => setDocumentFilters({ file_type: event.target.value })}
        >
          <option value="">全部类型</option>
          {SUPPORTED_FILE_TYPES.map((extension) => (
            <option key={extension} value={extension}>{extension.toUpperCase()}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-ink-secondary">
        <span>创建日期起</span>
        <input
          aria-label="创建日期起"
          type="date"
          max={documentFilters.date_to || undefined}
          className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
          value={documentFilters.date_from}
          onChange={(event) => setDocumentFilters({ date_from: event.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-ink-secondary">
        <span>创建日期止</span>
        <input
          aria-label="创建日期止"
          type="date"
          min={documentFilters.date_from || undefined}
          className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
          value={documentFilters.date_to}
          onChange={(event) => setDocumentFilters({ date_to: event.target.value })}
        />
      </label>
      {hasFilters && (
        <button
          type="button"
          aria-label="清除筛选"
          title="清除筛选"
          className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-line text-ink-secondary hover:bg-muted hover:text-ink"
          onClick={() => setDocumentFilters(EMPTY_FILTERS)}
        >
          <RotateCcw className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
