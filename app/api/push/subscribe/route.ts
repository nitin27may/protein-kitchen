import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import * as s from "@/lib/db/schema";
import { getDb } from "@/lib/server/context";

const Body = z.object({
  personId: z.number().int().positive(),
  endpoint: z.string().url().startsWith("https://"),
  keys: z.object({ p256dh: z.string().min(10), auth: z.string().min(10) }),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "Invalid subscription" }, { status: 400 });
  const { personId, endpoint, keys } = parsed.data;
  const db = getDb();
  if (!db.select({ id: s.people.id }).from(s.people).where(eq(s.people.id, personId)).get()) {
    return NextResponse.json({ ok: false, error: "Unknown profile" }, { status: 404 });
  }
  // One device belongs to one person at a time.
  db.delete(s.pushSubscriptions).where(eq(s.pushSubscriptions.endpoint, endpoint)).run();
  db.insert(s.pushSubscriptions).values({ personId, endpoint, p256dh: keys.p256dh, auth: keys.auth, createdAt: new Date().toISOString() }).run();
  return NextResponse.json({ ok: true });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const personId = Number(url.searchParams.get("personId"));
  const endpoint = url.searchParams.get("endpoint") ?? "";
  const row = getDb()
    .select({ id: s.pushSubscriptions.id })
    .from(s.pushSubscriptions)
    .where(and(eq(s.pushSubscriptions.personId, personId), eq(s.pushSubscriptions.endpoint, endpoint)))
    .get();
  return NextResponse.json({ subscribed: Boolean(row) });
}
