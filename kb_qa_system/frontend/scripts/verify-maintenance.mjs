import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const output = path.resolve("../../.tools/maintenance-qa");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const errors = [];
const calls = [];
const snapshot = { id: "a".repeat(32), created_at: "2026-09-20T01:00:00Z", verified: true, size_bytes: 44040192, within_restore_window: true };
const jobs = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(() => {
  localStorage.setItem("kb_auth_tokens", JSON.stringify({ access_token: "test-only", refresh_token: "test-only", token_type: "bearer", expires_in: 3600 }));
  localStorage.setItem("kb_auth_user", JSON.stringify({ id: 1, username: "test-admin", email: "test@example.test", is_active: true, is_superuser: true, user_type: "regular", created_at: "2026-09-01T00:00:00Z" }));
});
await page.routeWebSocket("**/ws/notifications", () => {});
await page.route("**/api/v1/**", async (route) => {
  const request = route.request();
  const endpoint = new URL(request.url()).pathname;
  const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
  if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
  if (endpoint.endsWith("/status")) return route.fulfill({ headers, json: { enabled: true, backup_enabled: true, storage_configured: true, store_available: true, restore_target: "recovery-test", interval_seconds: 86400, retention_count: 7, worker_seen_at: snapshot.created_at, worker_available: true } });
  if (endpoint.endsWith("/snapshots")) return route.fulfill({ headers, json: [snapshot] });
  if (endpoint.endsWith("/restore-plan")) return route.fulfill({ headers, json: { snapshot_id: snapshot.id, target_name: "recovery-test", target_stamp: "c".repeat(64), empty: true, requires_confirmation: true } });
  if (endpoint.endsWith("/jobs") && request.method() === "POST") {
    const body = request.postDataJSON(); calls.push(body);
    const job = { ...body, id: "b".repeat(32), state: "queued", actor_id: 1, created_at: snapshot.created_at, error_code: null };
    jobs.unshift(job); return route.fulfill({ status: 202, headers, json: job });
  }
  if (endpoint.endsWith("/jobs")) return route.fulfill({ headers, json: jobs });
  return route.fulfill({ status: 404, headers, json: { detail: "test endpoint unavailable" } });
});
try {
  await page.goto("http://127.0.0.1:1421/admin/backup-recovery");
  await expect(page.getByText("执行器在线，任务将在后台处理。")).toBeVisible();
  await page.getByRole("button", { name: "检查恢复条件" }).click();
  await expect(page.getByRole("button", { name: "提交恢复任务" })).toBeDisabled();
  await page.screenshot({ path: path.join(output, "desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: path.join(output, "mobile.png"), fullPage: true });
  await page.getByLabel("恢复目标确认").fill("recovery-test");
  await page.getByRole("button", { name: "提交恢复任务" }).click();
  await expect(page.getByText("恢复 · 等待执行")).toBeVisible();
  expect(calls).toHaveLength(1);
  expect(calls[0].snapshot_id).toBe(snapshot.id);
  expect(errors).toEqual([]);
  console.log("Maintenance UI: desktop/mobile, confirmation gate and submission passed; API mocked.");
} finally {
  await browser.close();
}
