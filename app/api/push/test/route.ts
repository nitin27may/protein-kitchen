import { privateJson } from "@/lib/auth/response";
import { z } from "zod";
import { sendToPerson, vapidConfigured } from "@/lib/server/push";
import { getPerson } from "@/lib/server/queries";
import { routeAccess } from "@/lib/auth/access";

export async function POST(req: Request) {
  const access = await routeAccess(req, true);
  if (access.response) return access.response;
  const parsed = z.object({ personId: z.number().int().positive() }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return privateJson({ ok: false, error: "Invalid request" }, 400);
  if (parsed.data.personId !== access.member.personId) return privateJson({ ok: false, error: "Use your linked profile for reminders." }, 403);
  if (!vapidConfigured()) return privateJson({ ok: false, error: "Reminders are not set up on the server yet." }, 503);
  const person = await getPerson(parsed.data.personId);
  if (!person) return privateJson({ ok: false, error: "Unknown profile" }, 404);
  const r = await sendToPerson(person.id, { title: "Test reminder", body: `Reminders are working for ${person.name}.`, url: "/" });
  if (r.sent === 0) return privateJson({ ok: false, error: "No device received it. Turn reminders on for this device first." }, 409);
  return privateJson({ ok: true, sent: r.sent });
}
