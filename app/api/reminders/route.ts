import { privateJson } from "@/lib/auth/response";
import { authorizeScheduler, hasSchedulerPayload } from "@/lib/server/scheduler";
import { dispatchReminders, vapidConfigured } from "@/lib/server/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const secret = process.env.REMINDER_SCHEDULER_SECRET;
  const reused = [process.env.STATE_SYNC_SCHEDULER_SECRET, process.env.BETTER_AUTH_SECRET, process.env.VAPID_PRIVATE_KEY].includes(secret);
  const auth = authorizeScheduler(request, process.env.REMINDER_SCHEDULER_ENABLED === "true" && !reused
    ? process.env.REMINDER_SCHEDULER_SECRET : undefined, process.env.VERCEL_ENV === "preview");
  if (auth !== "authorized") return privateJson({
    ok: false, error: auth === "disabled" ? "Reminder scheduler is disabled." : "Unauthorized.",
  }, auth === "disabled" ? 503 : 401);
  if (new URL(request.url).search) return privateJson({ ok: false, error: "Use an empty POST with no query parameters." }, 400);
  try {
    if (await hasSchedulerPayload(request)) return privateJson({ ok: false, error: "Reminders do not accept a request payload." }, 400);
    if (!vapidConfigured()) return privateJson({ ok: false, error: "Reminders are not configured." }, 503);
    const result = await dispatchReminders();
    return privateJson({ ok: result.retry === 0 && result.ambiguous === 0, ...result }, result.retry || result.ambiguous ? 503 : 200);
  } catch {
    console.error("Private reminder scheduler failed.", { code: "unavailable" });
    return privateJson({ ok: false, error: "Reminder scheduling is unavailable." }, 503);
  }
}
