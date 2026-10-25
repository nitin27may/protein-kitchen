import { privateJson } from "@/lib/auth/response";
import { z } from "zod";
import { hasPushSubscription, personExists, savePushSubscription } from "@/lib/server/subscriptions";
import { routeAccess } from "@/lib/auth/access";

const Body = z.object({
  personId: z.number().int().positive(),
  endpoint: z.string().url().startsWith("https://"),
  keys: z.object({ p256dh: z.string().min(10), auth: z.string().min(10) }),
});

export async function POST(req: Request) {
  const access = await routeAccess(req, true);
  if (access.response) return access.response;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return privateJson({ ok: false, error: "Invalid subscription" }, 400);
  const { personId, endpoint, keys } = parsed.data;
  if (personId !== access.member.personId) return privateJson({ ok: false, error: "Use your linked profile for reminders." }, 403);
  if (!(await personExists(personId))) {
    return privateJson({ ok: false, error: "Unknown profile" }, 404);
  }
  if (!(await savePushSubscription(personId, { endpoint, p256dh: keys.p256dh, auth: keys.auth }))) {
    return privateJson({ ok: false, error: "This device is registered to another account. Disable its old registration before enabling reminders." }, 409);
  }
  return privateJson({ ok: true });
}

export async function GET(req: Request) {
  const access = await routeAccess(req);
  if (access.response) return access.response;
  const url = new URL(req.url);
  const personId = Number(url.searchParams.get("personId"));
  if (personId !== access.member.personId) return privateJson({ ok: false, error: "Use your linked profile for reminders." }, 403);
  const endpoint = url.searchParams.get("endpoint") ?? "";
  return privateJson({ subscribed: await hasPushSubscription(personId, endpoint) });
}
