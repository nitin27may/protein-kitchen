import { NextResponse } from "next/server";
import { buildPdf } from "@/lib/export/pdf";
import { buildWorkbook } from "@/lib/export/xlsx";
import { getPlanExport } from "@/lib/server/export";
import { routeAccess } from "@/lib/auth/access";
import { privateJson } from "@/lib/auth/response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TYPES = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
} as const;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await routeAccess(req);
  if (access.response) return access.response;
  const { id } = await params;
  const planId = Number(id);
  const format = new URL(req.url).searchParams.get("format");
  if (!Number.isInteger(planId) || (format !== "xlsx" && format !== "pdf")) {
    return privateJson({ ok: false, error: "Use /api/plan/<id>/export?format=xlsx or pdf" }, 400);
  }
  const plan = await getPlanExport(planId);
  if (!plan) return privateJson({ ok: false, error: "Plan not found" }, 404);
  try {
    const file = format === "xlsx" ? await buildWorkbook(plan) : await buildPdf(plan);
    return new NextResponse(new Uint8Array(file), {
      headers: {
        "Content-Type": TYPES[format],
        "Content-Disposition": `attachment; filename="meal-plan-${plan.startDate}.${format}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    // Log a code only: error messages can carry file system paths.
    const code = (err as NodeJS.ErrnoException | null)?.code;
    console.error("Plan export failed.", { format, code: typeof code === "string" ? code : "unknown" });
    return privateJson(
      { ok: false, error: format === "pdf" ? "The PDF could not be built. Try again later." : "The file could not be built. Try again later." },
      500,
    );
  }
}
