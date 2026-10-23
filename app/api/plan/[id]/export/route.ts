import { NextResponse } from "next/server";
import { buildPdf } from "@/lib/export/pdf";
import { buildWorkbook } from "@/lib/export/xlsx";
import { getPlanExport } from "@/lib/server/export";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TYPES = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
} as const;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const planId = Number(id);
  const format = new URL(req.url).searchParams.get("format");
  if (!Number.isInteger(planId) || (format !== "xlsx" && format !== "pdf")) {
    return NextResponse.json({ ok: false, error: "Use /api/plan/<id>/export?format=xlsx or pdf" }, { status: 400 });
  }
  const plan = getPlanExport(planId);
  if (!plan) return NextResponse.json({ ok: false, error: "Plan not found" }, { status: 404 });
  try {
    const file = format === "xlsx" ? await buildWorkbook(plan) : await buildPdf(plan);
    return new NextResponse(new Uint8Array(file), {
      headers: {
        "Content-Type": TYPES[format],
        "Content-Disposition": `attachment; filename="meal-plan-${plan.startDate}.${format}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[export] failed", err);
    return NextResponse.json({ ok: false, error: "Could not build the file" }, { status: 500 });
  }
}
