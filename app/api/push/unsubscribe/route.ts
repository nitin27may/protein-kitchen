import { NextResponse } from "next/server";
import { z } from "zod";
import { deletePushSubscription } from "@/lib/server/subscriptions";

export async function POST(req: Request) {
  const parsed = z.object({ endpoint: z.string().min(10) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "Invalid request" }, { status: 400 });
  await deletePushSubscription(parsed.data.endpoint);
  return NextResponse.json({ ok: true });
}
