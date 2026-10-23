import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import * as s from "@/lib/db/schema";
import { getDb } from "@/lib/server/context";

export async function POST(req: Request) {
  const parsed = z.object({ endpoint: z.string().min(10) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "Invalid request" }, { status: 400 });
  getDb().delete(s.pushSubscriptions).where(eq(s.pushSubscriptions.endpoint, parsed.data.endpoint)).run();
  return NextResponse.json({ ok: true });
}
