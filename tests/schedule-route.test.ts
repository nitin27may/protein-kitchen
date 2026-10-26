import { beforeEach, describe, expect, it, vi } from "vitest";
import { routeAccess } from "../lib/auth/access";
import { getScheduleData } from "../lib/server/schedule";
import { buildSchedulePdf } from "../lib/export/schedule-pdf";
import { GET } from "../app/api/plan/[id]/schedule/route";
import type { PlanExport } from "../lib/export/model";

vi.mock("../lib/auth/access", () => ({ routeAccess: vi.fn() }));
vi.mock("../lib/server/schedule", () => ({ getScheduleData: vi.fn() }));
vi.mock("../lib/export/schedule-pdf", async (original) => ({ ...(await original<typeof import("../lib/export/schedule-pdf")>()), buildSchedulePdf: vi.fn() }));

const origin = "https://kitchen.example.test";
const get = (id: string, query = "") => GET(new Request(`${origin}/api/plan/${id}/schedule${query}`), { params: Promise.resolve({ id }) });
const plan: PlanExport = {
  title: "Meal plan", startDate: "2026-11-02", endDate: "2026-11-15", generatedOn: "2026-11-01",
  weeks: [{ n: 1, from: "2026-11-02", to: "2026-11-08", label: "Week 1" }, { n: 2, from: "2026-11-09", to: "2026-11-15", label: "Week 2" }],
  people: [{ id: 7, name: "Asha", proteinTargetG: 100, kcalTarget: null }], meals: [], days: [], averages: [], grocery: [], notes: [],
};
const pdf = Buffer.from("%PDF-1.7 synthetic");

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(routeAccess).mockResolvedValue({ member: { userId: "cook", role: "member", personId: 7 } });
  vi.mocked(getScheduleData).mockResolvedValue({ plan, prep: [] });
  vi.mocked(buildSchedulePdf).mockResolvedValue(pdf);
});

describe("GET /api/plan/[id]/schedule", () => {
  it.each([401, 403, 503])("returns %i from routeAccess before reading any plan data", async (code) => {
    vi.mocked(routeAccess).mockResolvedValue({ response: Response.json({ ok: false }, { status: code, headers: { "Cache-Control": "private, no-store" } }) });
    const res = await get("1");
    expect(res.status).toBe(code);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(getScheduleData).not.toHaveBeenCalled();
    expect(buildSchedulePdf).not.toHaveBeenCalled();
  });
  it("returns 404 when the plan is not in the member's household", async () => {
    vi.mocked(getScheduleData).mockResolvedValue(undefined);
    const res = await get("99");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(buildSchedulePdf).not.toHaveBeenCalled();
  });
  it.each(["abc", "0", "-3", "1.5"])("rejects plan id %s", async (id) => {
    expect((await get(id)).status).toBe(400);
    expect(getScheduleData).not.toHaveBeenCalled();
  });
  it.each(["?person=x", "?person=0", "?week=abc", "?week=0"])("rejects malformed query %s", async (q) => {
    expect((await get("1", q)).status).toBe(400);
    expect(getScheduleData).not.toHaveBeenCalled();
  });
  it("rejects a person or week that is not in the plan", async () => {
    expect((await get("1", "?person=8")).status).toBe(400);
    expect((await get("1", "?week=3")).status).toBe(400);
    expect(buildSchedulePdf).not.toHaveBeenCalled();
  });
  it("serves the PDF inline, uncached, named for the first day", async () => {
    const res = await get("1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="protein-kitchen-week-2026-11-02.pdf"');
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe(pdf.toString());
    expect(vi.mocked(buildSchedulePdf).mock.calls[0]![0].weeks).toHaveLength(2);
  });
  it("sends an attachment with ?download=1", async () => {
    const res = await get("1", "?download=1");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="protein-kitchen-week-2026-11-02.pdf"');
  });
  it("passes person and week through, and names the file for that week", async () => {
    const res = await get("1", "?person=7&week=2");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("protein-kitchen-week-2026-11-09.pdf");
    const model = vi.mocked(buildSchedulePdf).mock.calls[0]![0];
    expect(model.weeks.map((w) => w.n)).toEqual([2]);
    expect(model.audience).toBe("For Asha");
  });
  it("returns an uncached 500 when the PDF cannot be built", async () => {
    vi.mocked(buildSchedulePdf).mockRejectedValue(new Error("synthetic"));
    const res = await get("1");
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
});
