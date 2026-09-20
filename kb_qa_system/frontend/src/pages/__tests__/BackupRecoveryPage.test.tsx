import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import BackupRecoveryPage from "../BackupRecoveryPage";
import { maintenanceApi } from "@/api/maintenance";

vi.mock("@/api/maintenance", async (original) => ({
  ...await original<typeof import("@/api/maintenance")>(),
  maintenanceApi: { status: vi.fn(), snapshots: vi.fn(), jobs: vi.fn(), plan: vi.fn(), submit: vi.fn(), cancel: vi.fn() },
}));
const status = { enabled: true, backup_enabled: true, storage_configured: true, store_available: true, restore_target: "recovery-test", interval_seconds: 86400, retention_count: 7, worker_seen_at: null, worker_available: false };
const snapshot = { id: "a".repeat(32), created_at: "2026-09-20T01:00:00Z", verified: true, size_bytes: 1048576, within_restore_window: true };
const job = { id: "b".repeat(32), kind: "backup" as const, snapshot_id: null, actor_id: 1, state: "queued" as const, created_at: snapshot.created_at, started_at: null, finished_at: null, result_snapshot_id: null, error_code: null };
function mount() { return render(<MemoryRouter><BackupRecoveryPage /></MemoryRouter>); }

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(maintenanceApi.status).mockResolvedValue(status);
  vi.mocked(maintenanceApi.snapshots).mockResolvedValue([snapshot]);
  vi.mocked(maintenanceApi.jobs).mockResolvedValue([]);
  vi.mocked(maintenanceApi.submit).mockResolvedValue(job);
});

describe("BackupRecoveryPage", () => {
  it("shows disabled configuration without requesting storage lists", async () => {
    vi.mocked(maintenanceApi.status).mockResolvedValue({ ...status, enabled: false });
    mount();
    await screen.findByText("备份管理尚未启用。");
    expect(screen.getByRole("button", { name: "立即备份" })).toBeDisabled();
    expect(maintenanceApi.snapshots).not.toHaveBeenCalled();
    expect(maintenanceApi.jobs).not.toHaveBeenCalled();
  });

  it("requires a preflight and exact target confirmation before restore", async () => {
    const user = userEvent.setup();
    const plan = { snapshot_id: snapshot.id, target_name: "recovery-test", target_stamp: "c".repeat(64), empty: true, requires_confirmation: true };
    vi.mocked(maintenanceApi.plan).mockResolvedValue(plan);
    mount();
    await user.click(await screen.findByRole("button", { name: "检查恢复条件" }));
    const submit = await screen.findByRole("button", { name: "提交恢复任务" });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText("恢复目标确认"), "wrong");
    expect(submit).toBeDisabled();
    await user.clear(screen.getByLabelText("恢复目标确认"));
    await user.type(screen.getByLabelText("恢复目标确认"), "recovery-test");
    await user.click(submit);
    await waitFor(() => expect(maintenanceApi.submit).toHaveBeenCalledWith(expect.objectContaining({ kind: "restore", snapshot_id: snapshot.id, target_stamp: plan.target_stamp, confirmation: "recovery-test" })));
  });

  it("reuses the request id after an unconfirmed network failure", async () => {
    const user = userEvent.setup();
    vi.mocked(maintenanceApi.submit).mockRejectedValueOnce(new Error("network"));
    mount();
    await screen.findByText("执行器尚未连接或暂时离线，已提交的任务会等待执行。");
    await user.click(screen.getByRole("button", { name: "立即备份" }));
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "立即备份" }));
    await waitFor(() => expect(maintenanceApi.submit).toHaveBeenCalledTimes(2));
    const [first, second] = vi.mocked(maintenanceApi.submit).mock.calls;
    expect(first[0].request_id).toBe(second[0].request_id);
  });

  it("offers cancel only while queued and displays interrupted results", async () => {
    vi.mocked(maintenanceApi.jobs).mockResolvedValue([job, { ...job, id: "d".repeat(32), state: "running" }, { ...job, id: "e".repeat(32), state: "interrupted", error_code: "worker_interrupted" }]);
    mount();
    await screen.findByText("执行器中断，结果需核查；系统不会自动重复恢复。");
    expect(screen.getAllByRole("button", { name: "取消任务" })).toHaveLength(1);
  });
});
