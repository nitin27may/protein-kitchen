import { privateJson } from "@/lib/auth/response";
import { z } from "zod";
import { deletePushSubscription } from "@/lib/server/subscriptions";
import { routeAccess } from "@/lib/auth/access";

export async function POST(req: Request) {
  const access = await routeAccess(req, true);
  if (access.response) return access.response;
  const parsed = z.object({ endpoint: z.string().min(10) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return privateJson({ ok: false, error: "Invalid request" }, 400);
  await deletePushSubscription(parsed.data.endpoint, access.member.personId);
  return privateJson({ ok: true });
}
