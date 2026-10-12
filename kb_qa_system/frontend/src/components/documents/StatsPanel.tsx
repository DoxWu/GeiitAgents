/**
 * 文档统计面板组件
 *
 * 作用：
 *   展示文档统计概览信息，包括文档总数、处理状态分布、分块数、
 *   Token 消耗和平均质量分。帮助用户快速了解知识库整体状况。
 *
 * 使用方式：
 *   <StatsPanel />
 */

import { useEffect, useState } from "react";
import {
  FileText,
  CheckCircle,
  Loader,
  XCircle,
  AlertTriangle,
  Database,
  Coins,
  TrendingUp,
} from "lucide-react";
import { getDocumentStats } from "@/api/document";
import type { DocumentStats } from "@/types/document";
import type { DocumentScope } from "@/types/document";
import { cn } from "@/lib/utils";

/** 统计项配置 */
interface StatItemProps {
  /** 图标 */
  icon: React.ReactNode;
  /** 标签 */
  label: string;
  /** 数值 */
  value: string | number;
  /** 颜色样式 */
  color: string;
}

/** 单个统计项 */
function StatItem({ icon, label, value, color }: StatItemProps) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line bg-surface p-3">
      <div
        className={cn(
          "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded",
          color,
        )}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-xs text-ink-tertiary">{label}</p>
        <p className="text-sm font-semibold text-ink">{value}</p>
      </div>
    </div>
  );
}

/** StatsPanel 组件 */
export function StatsPanel({ scope }: { scope: DocumentScope }) {
  const [stats, setStats] = useState<DocumentStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    getDocumentStats(scope)
      .then((data) => { if (active) setStats(data); })
      .catch(() => { if (active) setError(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [scope, refreshKey]);

  function loadStats() {
    setRefreshKey((current) => current + 1);
  }

  // 加载中状态
  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-16 animate-pulse rounded-lg border border-line bg-muted/30"
          />
        ))}
      </div>
    );
  }

  // 错误状态
  if (error) {
    return (
      <div className="rounded-lg border border-line bg-surface p-4 text-center">
        <p className="text-xs text-ink-tertiary">统计加载失败</p>
        <button
          onClick={loadStats}
          className="mt-1 text-xs text-brand hover:underline"
        >
          重新加载
        </button>
      </div>
    );
  }

  // 无数据
  if (!stats || stats.total_documents === 0) {
    return null;
  }

  /** 格式化大数字（如 1200000 → 1.2M） */
  function formatNumber(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatItem
          icon={<FileText className="h-4 w-4 text-brand" />}
          label="文档总数"
          value={stats.total_documents}
          color="bg-brand-light"
        />
        <StatItem
          icon={<CheckCircle className="h-4 w-4 text-success" />}
          label="已完成"
          value={stats.completed}
          color="bg-green-50"
        />
        <StatItem
          icon={<Loader className="h-4 w-4 text-brand" />}
          label="处理中"
          value={stats.processing}
          color="bg-brand-light"
        />
        <StatItem
          icon={<XCircle className="h-4 w-4 text-danger" />}
          label="失败"
          value={stats.failed}
          color="bg-red-50"
        />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatItem
          icon={<AlertTriangle className="h-4 w-4 text-warning" />}
          label="低质量"
          value={stats.low_quality}
          color="bg-amber-50"
        />
        <StatItem
          icon={<Database className="h-4 w-4 text-ink-secondary" />}
          label="总分块"
          value={formatNumber(stats.total_chunks)}
          color="bg-muted"
        />
        <StatItem
          icon={<Coins className="h-4 w-4 text-ink-secondary" />}
          label="总 Token"
          value={formatNumber(stats.total_tokens)}
          color="bg-muted"
        />
        <StatItem
          icon={<TrendingUp className="h-4 w-4 text-success" />}
          label="平均质量分"
          value={
            stats.avg_quality_score !== null
              ? stats.avg_quality_score.toFixed(1)
              : "—"
          }
          color="bg-green-50"
        />
      </div>
    </div>
  );
}
