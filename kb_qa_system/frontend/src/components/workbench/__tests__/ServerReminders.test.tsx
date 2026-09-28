import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { auth, api } = vi.hoisted(() => ({
  auth: {
    isAuthenticated: false,
    user: null as { email: string } | null,
  },
  api: {
    getPersonalCapabilities: vi.fn(),
    listServerReminders: vi.fn(),
    createServerReminder: vi.fn(),
    updateServerReminder: vi.fn(),
    listReminderDeliveries: vi.fn(),
    retryReminderDelivery: vi.fn(),
  },
}));

vi.mock("@/store/authStore", () => ({
  useAuthStore: (selector: (state: typeof auth) => unknown) => selector(auth),
}));
vi.mock("@/api/personal", () => api);

import { ServerReminders } from "../ServerReminders";

const reminder = {
  id: 7,
  request_id: "request-7",
  revision: 3,
  todo_id: null,
  recipient: "user@example.com",
  subject: "提交周报",
  body: "请在今天完成周报。",
  timezone: "Asia/Shanghai",
  recurrence: "once" as const,
  next_run_at: "2099-01-02T01:00:00.000Z",
  status: "active" as const,
  last_run_at: null,
  created_at: "2099-01-01T00:00:00.000Z",
  updated_at: "2099-01-01T00:00:00.000Z",
};

function enableReminderApi() {
  api.getPersonalCapabilities.mockResolvedValue({
    email_reminders_enabled: true,
    recipient_policy: "account_email",
    scheduler_interval_seconds: 60,
  });
  api.listServerReminders.mockResolvedValue([]);
}

describe("ServerReminders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.isAuthenticated = false;
    auth.user = null;
    window.confirm = vi.fn(() => true);
    enableReminderApi();
  });

  afterEach(cleanup);

  it("requires a formal account before showing server reminder controls", () => {
    render(<ServerReminders />);
    expect(screen.getByText(/请登录正式账号/)).toBeInTheDocument();
    expect(api.getPersonalCapabilities).not.toHaveBeenCalled();
  });

  it("disables creation when the server capability is off", async () => {
    auth.isAuthenticated = true;
    auth.user = { email: "user@example.com" };
    api.getPersonalCapabilities.mockResolvedValue({
      email_reminders_enabled: false,
      recipient_policy: "account_email",
      scheduler_interval_seconds: 60,
    });
    render(<ServerReminders />);
    await waitFor(() => expect(screen.getByText(/邮件提醒功能当前未启用/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "保存提醒" })).toBeDisabled();
  });

  it("creates a reminder for the account email with a UTC timestamp", async () => {
    auth.isAuthenticated = true;
    auth.user = { email: "user@example.com" };
    const created = { ...reminder };
    api.createServerReminder.mockResolvedValue(created);
    render(<ServerReminders />);
    await waitFor(() => expect(screen.getByRole("button", { name: "保存提醒" })).toBeDisabled());
    fireEvent.change(screen.getByLabelText("提醒主题"), { target: { value: "提交周报" } });
    fireEvent.change(screen.getByLabelText("提醒内容"), { target: { value: "请在今天完成周报。" } });
    fireEvent.submit(screen.getByRole("button", { name: "保存提醒" }).closest("form")!);
    await waitFor(() => expect(api.createServerReminder).toHaveBeenCalledTimes(1));
    const payload = api.createServerReminder.mock.calls[0][0];
    expect(payload).toMatchObject({ subject: "提交周报", body: "请在今天完成周报。", timezone: expect.any(String), recurrence: "once", request_id: expect.any(String) });
    expect(payload.next_run_at).toMatch(/Z$/);
    expect(payload).not.toHaveProperty("recipient");
  });

  it("updates reminders with the current revision and requires confirmation for unknown delivery outcomes", async () => {
    auth.isAuthenticated = true;
    auth.user = { email: "user@example.com" };
    api.listServerReminders.mockResolvedValue([reminder]);
    api.updateServerReminder.mockResolvedValue({ ...reminder, revision: 4, status: "paused" });
    api.listReminderDeliveries.mockResolvedValue([{
      id: 11,
      reminder_id: 7,
      revision: 3,
      scheduled_at: reminder.next_run_at,
      status: "unknown",
      attempts: 1,
      retry_limit: 3,
      next_attempt_at: reminder.next_run_at,
      last_attempt_at: reminder.next_run_at,
      error_code: "delivery_outcome_unknown",
      created_at: reminder.next_run_at,
    }]);
    api.retryReminderDelivery.mockResolvedValue({ id: 11, status: "pending" });
    render(<ServerReminders />);
    await waitFor(() => expect(screen.getByText("提交周报")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() => expect(api.updateServerReminder).toHaveBeenCalledWith(7, { revision: 3, status: "paused" }));
    fireEvent.click(screen.getByRole("button", { name: /投递记录/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /确认风险并重试/ })).toBeInTheDocument());
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: /确认风险并重试/ }));
    expect(api.retryReminderDelivery).not.toHaveBeenCalled();
    vi.mocked(window.confirm).mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: /确认风险并重试/ }));
    await waitFor(() => expect(api.retryReminderDelivery).toHaveBeenCalledWith(7, 11, true));
  });
});
