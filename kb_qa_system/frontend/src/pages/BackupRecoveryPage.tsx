import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Database, RefreshCw } from "lucide-react";
import { Button } from "@/components/common/Button";
import { maintenanceApi, maintenanceError, type JobInput, type MaintenanceJob, type MaintenanceStatus, type RestorePlan, type Snapshot } from "@/api/maintenance";

const labels = { backup: "备份", verify: "恢复验证", restore: "恢复" };
const states = { queued: "等待执行", running: "正在执行", succeeded: "已完成", failed: "失败", interrupted: "执行中断", cancelled: "已取消" };
const date = (value: string) => new Date(value).toLocaleString("zh-CN");

export default function BackupRecoveryPage() {
  const [status, setStatus] = useState<MaintenanceStatus | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [jobs, setJobs] = useState<MaintenanceJob[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const requestIds = useRef(new Map<string, string>());
  const alive = useRef(true);
  const refreshController = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    refreshController.current?.abort();
    const controller = new AbortController();
    refreshController.current = controller;
    try {
      const next = await maintenanceApi.status(controller.signal);
      const [nextSnapshots, nextJobs] = next.enabled && next.storage_configured
        ? await Promise.all([maintenanceApi.snapshots(controller.signal), maintenanceApi.jobs(controller.signal)]) : [[], []];
      if (!alive.current || controller.signal.aborted) return;
      setStatus(next); setSnapshots(nextSnapshots); setJobs(nextJobs); setError("");
    } catch (e) {
      if (alive.current && !controller.signal.aborted) { setStatus(null); setError(maintenanceError(e)); }
    } finally {
      if (alive.current && !controller.signal.aborted) setLoading(false);
      if (refreshController.current === controller) refreshController.current = null;
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible" && !refreshController.current) void refresh(); }, 15_000);
    return () => { alive.current = false; clearInterval(timer); refreshController.current?.abort(); };
  }, [refresh]);

  async function action(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { await work(); }
    catch (e) { if (alive.current) setError(maintenanceError(e)); }
    finally { if (alive.current) setBusy(false); }
  }
  async function submit(input: Omit<JobInput, "request_id">) {
    const signature = JSON.stringify(input);
    const request_id = requestIds.current.get(signature) || crypto.randomUUID();
    requestIds.current.set(signature, request_id);
    const job = await maintenanceApi.submit({ ...input, request_id });
    requestIds.current.delete(signature);
    if (!alive.current) return;
    setNotice(`${labels[job.kind]}任务已接收，可在下方查看进度。`);
    setPlan(null); setConfirmation("");
    await refresh();
  }
  const enabled = Boolean(status?.enabled && status.store_available);
  return <div className="min-h-screen bg-canvas text-ink">
    <header className="border-b border-line bg-surface"><div className="mx-auto flex max-w-5xl items-center gap-3 px-5 py-4">
      <Link to="/settings" aria-label="返回设置" className="rounded p-2 hover:bg-muted"><ArrowLeft size={19} /></Link>
      <Database size={21} className="text-brand" /><h1 className="flex-1 text-lg font-semibold">备份与恢复</h1>
      <Button variant="secondary" size="sm" onClick={() => void refresh()} icon={<RefreshCw size={15} />}>刷新</Button>
    </div></header>
    <main className="mx-auto grid max-w-5xl gap-6 px-5 py-6">
      {error && <p role="alert" className="rounded border border-danger/30 p-3 text-sm text-danger">{error}</p>}
      {notice && <p role="status" className="rounded bg-brand-light p-3 text-sm">{notice}</p>}
      <section className="rounded-lg border border-line bg-surface p-5">
        <h2 className="mb-2 font-semibold">服务状态</h2>
        {loading ? <p>正在读取状态…</p> : status ? <>
          <p className="text-sm text-ink-secondary">{!status.enabled ? "备份管理尚未启用。" : !status.storage_configured ? "尚未配置备份存储。" : status.worker_available ? "执行器在线，任务将在后台处理。" : "执行器尚未连接或暂时离线，已提交的任务会等待执行。"}</p>
          <dl className="my-4 grid gap-3 text-sm sm:grid-cols-3">
            <div><dt className="text-ink-secondary">自动备份</dt><dd>{status.backup_enabled ? `每 ${Math.round(status.interval_seconds / 3600 * 10) / 10} 小时` : "已关闭"}</dd></div>
            <div><dt className="text-ink-secondary">快照保留</dt><dd>{status.retention_count} 份，任务引用的快照暂缓清理</dd></div>
            <div><dt className="text-ink-secondary">恢复目标</dt><dd>{status.restore_target || "未配置"}</dd></div>
          </dl>
          <Button disabled={!enabled || !status.backup_enabled || busy} onClick={() => void action(() => submit({ kind: "backup" }))}>立即备份</Button>
        </> : <p className="text-sm text-ink-secondary">状态暂不可用，刷新后再操作。</p>}
      </section>
      <section className="rounded-lg border border-line bg-surface p-5">
        <h2 className="font-semibold">备份快照</h2>
        <p className="mt-1 text-sm text-ink-secondary">验证会在临时库中实际还原。恢复写入单独配置的空目标库，已有数据时拒绝执行。</p>
        {!snapshots.length && <p className="py-6 text-sm text-ink-secondary">暂无备份快照。</p>}
        <div className="mt-3 divide-y divide-line">{snapshots.map((snapshot) => <article key={snapshot.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1"><p className="text-sm font-medium">{date(snapshot.created_at)}</p><p className="break-all font-mono text-xs text-ink-secondary">{snapshot.id}</p><p className="mt-1 text-xs text-ink-secondary">{(snapshot.size_bytes / 1024 / 1024).toFixed(1)} MiB · {snapshot.verified ? "已通过备份验证" : "未验证"} · {snapshot.within_restore_window ? "有效期内" : "超出恢复时限"}</p></div>
          <div className="flex shrink-0 gap-3"><Button size="sm" variant="secondary" disabled={!enabled || busy || !snapshot.verified || !snapshot.within_restore_window} onClick={() => void action(() => submit({ kind: "verify", snapshot_id: snapshot.id }))}>验证</Button>
          <Button size="sm" variant="secondary" disabled={!enabled || busy || !status?.restore_target || !snapshot.verified || !snapshot.within_restore_window} onClick={() => void action(async () => {
            setPlan(null); setConfirmation(""); const next = await maintenanceApi.plan(snapshot.id); if (alive.current) setPlan(next);
          })}>检查恢复条件</Button></div>
        </article>)}</div>
      </section>
      {plan && <section className="rounded-lg border border-brand bg-surface p-5" aria-label="确认恢复">
        <h2 className="font-semibold">确认恢复目标</h2>
        <p className="my-3 break-all text-sm">快照 {plan.snapshot_id} 将恢复到 {plan.target_name}。目标目前为空，执行前会再次校验。此操作不会自动切换应用的数据源。</p>
        <label className="grid gap-2 text-sm">输入目标名称 {plan.target_name}<input aria-label="恢复目标确认" className="rounded border border-line bg-canvas p-2" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} autoComplete="off" /></label>
        <div className="mt-4 flex gap-3"><Button disabled={!enabled || busy || confirmation !== plan.target_name} onClick={() => void action(() => submit({ kind: "restore", snapshot_id: plan.snapshot_id, target_stamp: plan.target_stamp, confirmation }))}>提交恢复任务</Button><Button variant="secondary" disabled={busy} onClick={() => setPlan(null)}>取消</Button></div>
      </section>}
      <section className="rounded-lg border border-line bg-surface p-5">
        <h2 className="font-semibold">最近任务</h2>
        <p className="mt-1 text-sm text-ink-secondary">关闭页面后任务仍会执行。只能取消尚未开始的任务；中断的恢复任务需要核查结果后重新提交。</p>
        {!jobs.length && <p className="py-6 text-sm text-ink-secondary">暂无任务。</p>}
        <div className="mt-3 divide-y divide-line">{jobs.map((job) => <article key={job.id} className="flex flex-wrap items-start gap-3 py-4">
          <div className="min-w-0 flex-1"><p className="text-sm font-medium">{labels[job.kind]} · {states[job.state]}</p><p className="mt-1 text-xs text-ink-secondary">{date(job.created_at)} · 操作者 #{job.actor_id}</p><p className="break-all font-mono text-xs text-ink-secondary">{job.id}</p>{job.error_code && <p className="mt-2 text-sm text-danger">{maintenanceError(job.error_code)}</p>}</div>
          {job.state === "queued" && <Button size="sm" variant="secondary" disabled={!enabled || busy} onClick={() => void action(async () => { await maintenanceApi.cancel(job.id); await refresh(); })}>取消任务</Button>}
        </article>)}</div>
      </section>
    </main>
  </div>;
}
