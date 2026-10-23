import { NextResponse } from "next/server";
import { z } from "zod";
import { hasPushSubscription, personExists, savePushSubscription } from "@/lib/server/subscriptions";

const Body = z.object({
  personId: z.number().int().positive(),
  endpoint: z.string().url().startsWith("https://"),
  keys: z.object({ p256dh: z.string().min(10), auth: z.string().min(10) }),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "Invalid subscription" }, { status: 400 });
  const { personId, endpoint, keys } = parsed.data;
  if (!(await personExists(personId))) {
    return NextResponse.json({ ok: false, error: "Unknown profile" }, { status: 404 });
  }
  // One device belongs to one person at a time.
  await savePushSubscription(personId, { endpoint, p256dh: keys.p256dh, auth: keys.auth });
  return NextResponse.json({ ok: true });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const personId = Number(url.searchParams.get("personId"));
  const endpoint = url.searchParams.get("endpoint") ?? "";
  return NextResponse.json({ subscribed: await hasPushSubscription(personId, endpoint) });
}
