import { NextResponse } from "next/server";
import { z } from "zod";
import { sendToPerson, vapidConfigured } from "@/lib/server/push";
import { getPerson } from "@/lib/server/queries";

export async function POST(req: Request) {
  const parsed = z.object({ personId: z.number().int().positive() }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "Invalid request" }, { status: 400 });
  if (!vapidConfigured()) return NextResponse.json({ ok: false, error: "Reminders are not set up on the server yet." }, { status: 503 });
  const person = await getPerson(parsed.data.personId);
  if (!person) return NextResponse.json({ ok: false, error: "Unknown profile" }, { status: 404 });
  const r = await sendToPerson(person.id, { title: "Test reminder", body: `Reminders are working for ${person.name}.`, url: "/" });
  if (r.sent === 0) return NextResponse.json({ ok: false, error: "No device received it. Turn reminders on for this device first." }, { status: 409 });
  return NextResponse.json({ ok: true, sent: r.sent });
}
