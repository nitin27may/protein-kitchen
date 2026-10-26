import { NextResponse } from "next/server";
import { buildScheduleModel } from "@/lib/export/schedule-model";
import { buildSchedulePdf } from "@/lib/export/schedule-pdf";
import { getScheduleData } from "@/lib/server/schedule";
import { routeAccess } from "@/lib/auth/access";
import { privateJson } from "@/lib/auth/response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const positiveInt = (value: string | null): number | null | undefined => {
  if (value === null) return null;
  return /^[1-9]\d{0,8}$/.test(value) ? Number(value) : undefined;
};

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await routeAccess(req);
  if (access.response) return access.response;
  const { id } = await params;
  const planId = Number(id);
  const query = new URL(req.url).searchParams;
  const person = positiveInt(query.get("person"));
  const week = positiveInt(query.get("week"));
  if (!Number.isSafeInteger(planId) || planId <= 0 || person === undefined || week === undefined) {
    return privateJson({ ok: false, error: "Use /api/plan/<id>/schedule with optional ?person=<id>&week=<n>&download=1" }, 400);
  }
  const data = await getScheduleData(planId);
  if (!data) return privateJson({ ok: false, error: "Plan not found" }, 404);
  const model = buildScheduleModel(data.plan, data.prep, { personId: person, week });
  if (!model) return privateJson({ ok: false, error: "That person or week is not in this plan" }, 400);
  try {
    const file = await buildSchedulePdf(model);
    const disposition = query.get("download") === "1" ? "attachment" : "inline";
    return new NextResponse(new Uint8Array(file), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${disposition}; filename="protein-kitchen-week-${model.weeks[0]!.from}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    console.error("[schedule] failed", err);
    return privateJson({ ok: false, error: "Could not build the schedule" }, 500);
  }
}
