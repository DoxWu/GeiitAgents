import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    dismissReminderDelivery: vi.fn(),
    getServerReminder: vi.fn(),
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
const page = <T extends { id: number }>(items: T[], next_cursor: number | null = null, snapshot_id = items[0]?.id ?? 0) => ({ items, next_cursor, snapshot_id });

function enableReminderApi() {
  api.getPersonalCapabilities.mockResolvedValue({
    email_reminders_enabled: true,
    recipient_policy: "account_email",
    scheduler_interval_seconds: 60,
  });
  api.listServerReminders.mockResolvedValue(page([]));
}

describe("ServerReminders", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    auth.isAuthenticated = false;
    auth.user = null;
    window.confirm = vi.fn(() => true);
    enableReminderApi();
    api.getServerReminder.mockResolvedValue(reminder);
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

  it("requires confirmation for unknown delivery retries", async () => {
    auth.isAuthenticated = true;
    auth.user = { email: "user@example.com" };
    api.listServerReminders.mockResolvedValue(page([reminder]));
    api.updateServerReminder.mockResolvedValue({ ...reminder, revision: 4, status: "paused" });
    api.listReminderDeliveries.mockResolvedValue(page([{
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
    }]));
    api.retryReminderDelivery.mockResolvedValue({ id: 11, status: "pending" });
    render(<ServerReminders />);
    await waitFor(() => expect(screen.getByText("提交周报")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /投递记录/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /确认风险并重试/ })).toBeInTheDocument());
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: /确认风险并重试/ }));
    expect(api.retryReminderDelivery).not.toHaveBeenCalled();
    vi.mocked(window.confirm).mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: /确认风险并重试/ }));
    await waitFor(() => expect(api.retryReminderDelivery).toHaveBeenCalledWith(7, 11, true));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已提交重试'));
  });

  async function loaded(item = reminder) {
    auth.isAuthenticated = true; auth.user = { email: 'user@example.com' };
    api.listServerReminders.mockResolvedValue(page([item]));
    const view = render(<ServerReminders />);
    await screen.findByRole('button', { name: '编辑 / 改期' });
    return view;
  }
  it('pauses using the viewed revision and displays the server result', async () => {
    await loaded(); api.updateServerReminder.mockResolvedValue({ ...reminder, revision: 4, status: 'paused' });
    fireEvent.click(screen.getByRole('button', { name: '暂停' }));
    await screen.findByRole('button', { name: '恢复' });
    expect(api.updateServerReminder).toHaveBeenCalledWith(7, { revision: 3, status: 'paused' });
  });
  it('edits schedule and recurrence using the reminder zone, with one revision-guarded update', async () => {
    await loaded(); api.updateServerReminder.mockResolvedValue({ ...reminder, revision: 4, recurrence: 'weekly' });
    fireEvent.click(screen.getByRole('button', { name: '编辑 / 改期' }));
    expect(screen.getByLabelText('提醒时区')).toHaveValue('Asia/Shanghai');
    expect(screen.getByLabelText('提醒时间')).toHaveValue('2099-01-02T09:00');
    fireEvent.change(screen.getByLabelText('提醒时间'), { target: { value: '2099-01-03T10:30' } });
    fireEvent.change(screen.getByLabelText('提醒重复规则'), { target: { value: 'weekly' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await screen.findByRole('status');
    expect(api.updateServerReminder).toHaveBeenCalledWith(7, { revision: 3, next_run_at: '2099-01-03T02:30:00.000Z', timezone: 'Asia/Shanghai', recurrence: 'weekly' });
  });
  it('does not move the schedule when only content changes', async () => {
    await loaded({ ...reminder, next_run_at: '2099-01-02T01:00:37.000Z' });
    api.updateServerReminder.mockResolvedValue({ ...reminder, revision: 4, body: 'new body' });
    fireEvent.click(screen.getByRole('button', { name: '编辑 / 改期' }));
    fireEvent.change(screen.getByLabelText('提醒内容'), { target: { value: 'new body' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await screen.findByRole('status');
    expect(api.updateServerReminder).toHaveBeenCalledWith(7, { revision: 3, body: 'new body' });
  });
  it('preserves conflicting drafts, forbids blind retry, and explicitly reloads the latest revision', async () => {
    await loaded(); api.updateServerReminder.mockRejectedValueOnce(new Error('revision_conflict'));
    fireEvent.click(screen.getByRole('button', { name: '编辑 / 改期' }));
    fireEvent.change(screen.getByLabelText('提醒内容'), { target: { value: 'my draft' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await screen.findByRole('button', { name: '载入最新版本（放弃草稿）' });
    expect(screen.getByLabelText('提醒内容')).toHaveValue('my draft');
    expect(screen.getByRole('button', { name: '保存修改' })).toBeDisabled();
    api.getServerReminder.mockResolvedValue({ ...reminder, revision: 8, body: 'other window' });
    fireEvent.click(screen.getByRole('button', { name: '载入最新版本（放弃草稿）' }));
    await waitFor(() => expect(screen.getByLabelText('提醒内容')).toHaveValue('other window'));
    api.updateServerReminder.mockResolvedValue({ ...reminder, revision: 9 });
    fireEvent.change(screen.getByLabelText('提醒内容'), { target: { value: 'merged draft' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await screen.findByRole('status');
    expect(api.updateServerReminder).toHaveBeenLastCalledWith(7, { revision: 8, body: 'merged draft' });
  });
  it('routes overdue resume into explicit rescheduling instead of repeatedly sending an invalid patch', async () => {
    auth.isAuthenticated = true; auth.user = { email: 'user@example.com' };
    api.listServerReminders.mockResolvedValue(page([{ ...reminder, status: 'paused', next_run_at: '2000-01-01T00:00:00Z' }]));
    api.updateServerReminder.mockResolvedValue({ ...reminder, revision: 4 }); render(<ServerReminders />);
    fireEvent.click(await screen.findByRole('button', { name: '恢复' }));
    expect(api.updateServerReminder).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox', { name: '保存后恢复提醒' })).toBeChecked();
    fireEvent.change(screen.getByLabelText('提醒时间'), { target: { value: '2099-01-03T09:00' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(api.updateServerReminder).toHaveBeenCalledWith(7, expect.objectContaining({ status: 'active', next_run_at: '2099-01-03T01:00:00.000Z' })));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已修改'));
  });
  it('reuses the creation request id after an uncertain HTTP failure', async () => {
    await loaded(); api.createServerReminder.mockRejectedValueOnce(new Error('network unavailable')).mockResolvedValueOnce(reminder);
    fireEvent.change(screen.getByLabelText('提醒主题'), { target: { value: 'new reminder' } });
    fireEvent.change(screen.getByLabelText('提醒内容'), { target: { value: 'content' } });
    fireEvent.click(screen.getByRole('button', { name: '保存提醒' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: '保存提醒' }));
    await screen.findByRole('status');
    expect(api.createServerReminder.mock.calls[0][0]).toEqual(api.createServerReminder.mock.calls[1][0]);
  });
  it('shows retry errors and requires confirmation before dismissing an unknown delivery', async () => {
    await loaded();
    const delivery = { id: 11, revision: 3, status: 'unknown', scheduled_at: reminder.next_run_at, attempts: 1, retry_limit: 3 };
    api.listReminderDeliveries.mockResolvedValue(page([delivery]));
    api.retryReminderDelivery.mockRejectedValue(new Error('delivery_not_retryable'));
    fireEvent.click(screen.getByRole('button', { name: '投递记录' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认风险并重试' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('不能重试'));
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: '人工结束本次尝试' }));
    expect(api.dismissReminderDelivery).not.toHaveBeenCalled();
    api.dismissReminderDelivery.mockResolvedValue({ ...delivery, status: 'cancelled', error_code: 'uncertain_delivery_dismissed' });
    fireEvent.click(screen.getByRole('button', { name: '人工结束本次尝试' }));
    await screen.findByText('人工结束（可能已发送）');
    expect(api.dismissReminderDelivery).toHaveBeenCalledWith(7, 11);
    await waitFor(() => expect(screen.getByRole('button', { name: '刷新邮件提醒' })).toBeEnabled());
  });
  it('ignores late list responses and clears drafts when the account changes', async () => {
    auth.isAuthenticated = true; auth.user = { email: 'old@example.com' };
    let resolve!: (rows: ReturnType<typeof page<typeof reminder>>) => void;
    api.listServerReminders.mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValueOnce(page([]));
    const view = render(<ServerReminders />);
    auth.user = { email: 'new@example.com' }; view.rerender(<ServerReminders />);
    await screen.findByText('还没有服务端提醒。');
    await act(async () => { resolve(page([reminder])); });
    expect(screen.queryByText('提交周报')).not.toBeInTheDocument();
    expect(screen.getByLabelText('提醒主题')).toHaveValue('');
  });
  it('keeps unsaved drafts when switching records is declined, and prevents duplicate saves', async () => {
    await loaded();
    fireEvent.change(screen.getByLabelText('提醒主题'), { target: { value: 'unsaved draft' } });
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: '编辑 / 改期' }));
    expect(screen.getByLabelText('提醒主题')).toHaveValue('unsaved draft');
    fireEvent.click(screen.getByRole('button', { name: '编辑 / 改期' }));
    fireEvent.change(screen.getByLabelText('提醒内容'), { target: { value: 'edited' } });
    let finish!: (item: typeof reminder) => void;
    api.updateServerReminder.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const form = screen.getByRole('button', { name: '保存修改' }).closest('form')!;
    fireEvent.submit(form); fireEvent.submit(form);
    expect(api.updateServerReminder).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('提醒内容')).toBeDisabled();
    await act(async () => { finish({ ...reminder, revision: 4 }); });
    await screen.findByRole('status');
  });
  it('pages in a fixed ID window without accumulating cards, and preserves the editor draft', async () => {
    auth.isAuthenticated = true; auth.user = { email: 'user@example.com' };
    const older = { ...reminder, id: 3, subject: '更早的提醒' };
    api.listServerReminders.mockResolvedValueOnce(page([reminder], 7, 9)).mockResolvedValueOnce(page([older], null, 9)).mockResolvedValueOnce(page([reminder], 7, 9));
    render(<ServerReminders />); fireEvent.click(await screen.findByRole('button', { name: '编辑 / 改期' }));
    fireEvent.change(screen.getByLabelText('提醒内容'), { target: { value: '保持我的草稿' } });
    fireEvent.click(screen.getByRole('button', { name: '下一页提醒' }));
    await screen.findByRole('article', { name: '提醒：更早的提醒' });
    expect(api.listServerReminders).toHaveBeenLastCalledWith(7, 9);
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.getByLabelText('提醒内容')).toHaveValue('保持我的草稿');
    expect(screen.getByRole('button', { name: '下一页提醒' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '上一页提醒' }));
    await screen.findByRole('article', { name: '提醒：提交周报' });
    expect(api.listServerReminders).toHaveBeenLastCalledWith(undefined, 9);
  });
  it('keeps the current page and cursor after a failed next-page request, then resets the window on refresh', async () => {
    auth.isAuthenticated = true; auth.user = { email: 'user@example.com' };
    api.listServerReminders.mockResolvedValueOnce(page([reminder], 7, 10)).mockRejectedValueOnce(new Error('temporary failure')).mockResolvedValueOnce(page([{ ...reminder, id: 20, subject: '新提醒' }], null, 20));
    render(<ServerReminders />); await screen.findByRole('article');
    fireEvent.click(screen.getByRole('button', { name: '下一页提醒' })); await screen.findByRole('alert');
    expect(screen.getByText('第 1 页 · 本页 1 条')).toBeInTheDocument();
    expect(screen.getByRole('article')).toHaveAccessibleName('提醒：提交周报');
    fireEvent.click(screen.getByRole('button', { name: '刷新邮件提醒' }));
    await screen.findByRole('article', { name: '提醒：新提醒' });
    expect(api.listServerReminders).toHaveBeenLastCalledWith();
    expect(screen.getByRole('button', { name: '上一页提醒' })).toBeDisabled();
  });
  it('pages deliveries independently and reopens their newest window', async () => {
    await loaded();
    const delivery = { id: 11, revision: 3, status: 'unknown', scheduled_at: reminder.next_run_at, attempts: 1, retry_limit: 3 };
    api.listReminderDeliveries.mockResolvedValueOnce(page([delivery], 11, 15)).mockResolvedValueOnce(page([{ ...delivery, id: 4, status: 'sent' }], null, 15)).mockResolvedValueOnce(page([{ ...delivery, id: 21 }], null, 21));
    fireEvent.click(screen.getByRole('button', { name: '投递记录' })); await screen.findByRole('button', { name: '下一页投递' });
    fireEvent.click(screen.getByRole('button', { name: '下一页投递' })); await screen.findByText('已发送');
    expect(api.listReminderDeliveries).toHaveBeenLastCalledWith(7, 11, 15);
    expect(screen.queryByText('结果不明')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '投递记录' }));
    fireEvent.click(screen.getByRole('button', { name: '投递记录' })); await screen.findByText('结果不明');
    expect(api.listReminderDeliveries).toHaveBeenLastCalledWith(7);
    expect(screen.getByRole('button', { name: '上一页投递' })).toBeDisabled();
  });
});
