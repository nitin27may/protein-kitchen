import webpush from "web-push";
import { validatePostgresTarget } from "../db/postgres/target";
import type { ReminderMessage } from "./due";

type Environment = Readonly<Record<string, string | undefined>>;
type Registration = { endpoint: string; p256dh: string; auth: string };

/** Explicit loopback-only synthetic transport; never a production push proxy. */
export function syntheticPushTarget(env: Environment): { endpoint: string; secret: string } {
  if (env.NODE_ENV !== "development" || env.DATABASE_ENV !== "development" || env.AUTH_TEST_MAILBOX !== "1" || env.VERCEL || env.VERCEL_ENV) {
    throw new Error("Synthetic reminders require explicit local browser development.");
  }
  const database = validatePostgresTarget({
    connectionString: env.DATABASE_URL ?? "", databaseEnvironment: "development", runtimeEnvironment: "development",
  });
  const url = new URL(env.REMINDER_TEST_PUSH_URL ?? "");
  const secret = env.REMINDER_TEST_PUSH_SECRET;
  if (!["localhost", "127.0.0.1", "[::1]"].includes(database.hostname) || database.pathname !== "/protein_kitchen_e2e" ||
      url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/" ||
      url.search || url.hash || url.username || url.password || !secret || !/^[a-zA-Z0-9_-]{32,128}$/.test(secret)) {
    throw new Error("Synthetic reminders require the disposable loopback database and private loopback fixture.");
  }
  return { endpoint: url.origin, secret };
}

export async function sendPush(registration: Registration, payload: ReminderMessage, env: Environment = process.env): Promise<void> {
  if (env.REMINDER_TEST_PUSH_URL !== undefined) {
    const target = syntheticPushTarget(env);
    const device = new URL(registration.endpoint);
    if (device.origin !== "https://push.example.test" || device.username || device.password ||
        registration.p256dh !== "synthetic-p256dh-key" || registration.auth !== "synthetic-auth-key") {
      throw new Error("Synthetic reminders refused a non-synthetic registration.");
    }
    const response = await fetch(target.endpoint, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${target.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ device: device.pathname, payload }),
    });
    await response.body?.cancel();
    if (!response.ok) throw Object.assign(new Error("Synthetic provider rejected the notification."), { statusCode: response.status });
    return;
  }
  await webpush.sendNotification({ endpoint: registration.endpoint, keys: { p256dh: registration.p256dh, auth: registration.auth } },
    JSON.stringify(payload), { TTL: 60 * 60 * 6, timeout: 10_000 });
}
