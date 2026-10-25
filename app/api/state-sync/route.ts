import { z } from "zod";
import { schedulerAuthorized, StateSyncConfigurationError } from "@/lib/sync/config";
import { configuredStateSync } from "@/lib/sync/server";
import { hasSchedulerPayload } from "@/lib/server/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

export async function POST(request: Request) {
  const auth = schedulerAuthorized(request, process.env);
  if (auth !== "authorized") return Response.json({ ok: false, error: auth === "disabled" ? "State sync scheduler is disabled." : "Unauthorized." }, { status: auth === "disabled" ? 503 : 401, headers });
  const key = z.string().uuid().safeParse(request.headers.get("idempotency-key"));
  if (!key.success || new URL(request.url).search) {
    return Response.json({ ok: false, error: "Use an empty POST with a UUID Idempotency-Key and no query parameters." }, { status: 400, headers });
  }
  try {
    if (await hasSchedulerPayload(request)) return Response.json({ ok: false, error: "State sync does not accept a request payload." }, { status: 400, headers });
    const result = await configuredStateSync(key.data);
    return Response.json({ ok: result.state === "success", ...result }, {
      status: result.state === "success" ? 200 : result.state === "busy" || result.state === "conflict" ? 409 : 503, headers,
    });
  } catch (error) {
    console.error("Private state scheduler failed.", { code: error instanceof StateSyncConfigurationError ? "not-configured" : "unavailable" });
    return Response.json({ ok: false, error: "State sync is unavailable." }, { status: 503, headers });
  }
}
