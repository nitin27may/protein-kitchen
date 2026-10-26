import { healthReport } from "@/lib/health/status";
import { getData, getHealthDb } from "@/lib/server/context";

export const dynamic = "force-dynamic";

/** Public on purpose and unauthenticated: a fixed-shape liveness and release probe that returns no values. */
export async function GET() {
  const { status, body } = await healthReport({ release: process.env.APP_RELEASE_SHA, db: getHealthDb, data: getData });
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
