import { apiClient } from "@/api/client";

export type ReminderRecurrence = "once" | "daily" | "weekly";
export type ReminderStatus = "active" | "paused" | "cancelled" | "completed";
export type DeliveryStatus = "pending" | "failed" | "unknown" | "sending" | "sent" | "cancelled" | "completed";

export interface PersonalCapabilities {
  email_reminders_enabled: boolean;
  recipient_policy: "account_email";
  scheduler_interval_seconds: number;
}

export interface ServerReminder {
  id: number;
  request_id: string;
  revision: number;
  todo_id: number | null;
  recipient: string;
  subject: string;
  body: string;
  timezone: string;
  recurrence: ReminderRecurrence;
  next_run_at: string | null;
  status: ReminderStatus;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReminderDelivery {
  id: number;
  reminder_id: number;
  revision: number;
  scheduled_at: string;
  status: DeliveryStatus;
  attempts: number;
  retry_limit: number;
  next_attempt_at: string;
  last_attempt_at: string | null;
  error_code: string | null;
  created_at: string;
}

export function getPersonalCapabilities() {
  return apiClient.get<PersonalCapabilities>("/personal/capabilities", { cache: "no-store" });
}

export function listServerReminders() {
  return apiClient.get<ServerReminder[]>("/personal/reminders", { cache: "no-store" });
}

export function getServerReminder(id: number) {
  return apiClient.get<ServerReminder>(`/personal/reminders/${id}`, { cache: 'no-store' });
}

export function createServerReminder(input: {
  request_id: string;
  subject: string;
  body: string;
  timezone: string;
  recurrence: ReminderRecurrence;
  next_run_at: string;
}) {
  return apiClient.post<ServerReminder>("/personal/reminders", input, { cache: "no-store" });
}

export function updateServerReminder(id: number, input: {
  revision: number;
  status?: "active" | "paused" | "cancelled";
  next_run_at?: string;
  subject?: string;
  body?: string;
  timezone?: string;
  recurrence?: ReminderRecurrence;
}) {
  return apiClient.patch<ServerReminder>(`/personal/reminders/${id}`, input, { cache: "no-store" });
}

export function cancelServerReminder(id: number) {
  return apiClient.delete<void>(`/personal/reminders/${id}`, { cache: "no-store" });
}

export function listReminderDeliveries(id: number) {
  return apiClient.get<ReminderDelivery[]>(`/personal/reminders/${id}/deliveries`, { cache: "no-store" });
}

export function retryReminderDelivery(reminderId: number, deliveryId: number, acknowledgeDuplicateRisk: boolean) {
  return apiClient.post<ReminderDelivery>(
    `/personal/reminders/${reminderId}/deliveries/${deliveryId}/retry`,
    { acknowledge_duplicate_risk: acknowledgeDuplicateRisk },
    { cache: "no-store" },
  );
}

export function dismissReminderDelivery(reminderId: number, deliveryId: number) {
  return apiClient.post<ReminderDelivery>(`/personal/reminders/${reminderId}/deliveries/${deliveryId}/dismiss`, { acknowledge_delivery_uncertainty: true }, { cache: 'no-store' });
}
