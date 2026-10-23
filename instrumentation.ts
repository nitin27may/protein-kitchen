// Runs once when the server starts. Starts the once-a-minute reminder check on the Node runtime only.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const g = globalThis as unknown as { __pkReminderTimer?: ReturnType<typeof setInterval> };
  if (g.__pkReminderTimer) return;
  const { checkReminders, vapidConfigured } = await import("@/lib/server/push");
  if (!vapidConfigured()) {
    console.log("[reminders] VAPID keys not set, reminders are off. See .env.example.");
    return;
  }
  g.__pkReminderTimer = setInterval(() => {
    checkReminders().catch((e) => console.error("[reminders] check failed", e));
  }, 60_000);
  console.log("[reminders] checking every minute");
}
