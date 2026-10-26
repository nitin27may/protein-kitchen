import { beforeEach, describe, expect, it, vi } from "vitest";
import { getScheduleData } from "../lib/server/schedule";
import { getPlanExport } from "../lib/server/export";
import { getPartModes, getPlanView, routineContext } from "../lib/server/queries";
import { buildNight } from "../lib/prep/night";
import { getData } from "../lib/server/context";

vi.mock("../lib/server/context", () => ({ getData: vi.fn() }));
vi.mock("../lib/server/export", () => ({ getPlanExport: vi.fn() }));
vi.mock("../lib/prep/night", () => ({ buildNight: vi.fn() }));
vi.mock("../lib/server/prep", () => ({ mealsOf: vi.fn(() => []) }));
vi.mock("../lib/server/queries", () => ({ getPlanView: vi.fn(), getPartModes: vi.fn(), routineContext: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
});

describe("getScheduleData", () => {
  it("is undefined when the plan is not visible to the household", async () => {
    vi.mocked(getPlanView).mockResolvedValue(undefined);
    expect(await getScheduleData(5)).toBeUndefined();
    expect(getPlanExport).not.toHaveBeenCalled();
  });
  it("is undefined when the export is missing", async () => {
    vi.mocked(getPlanView).mockResolvedValue({ id: 5 } as never);
    vi.mocked(getPlanExport).mockResolvedValue(undefined);
    expect(await getScheduleData(5)).toBeUndefined();
  });
  it("returns the export and night tasks without writing anything", async () => {
    vi.mocked(getPlanView).mockResolvedValue({ id: 5, startDate: "2026-11-02", prepDay: null, input: { prepStyle: null } } as never);
    vi.mocked(getPlanExport).mockResolvedValue({ title: "p" } as never);
    vi.mocked(getData).mockReturnValue({ recipes: new Map() } as never);
    vi.mocked(getPartModes).mockResolvedValue({} as never);
    vi.mocked(routineContext).mockResolvedValue({ refs: [], inputs: [] });
    vi.mocked(buildNight).mockReturnValue({ guide: {} as never, tasks: [{ key: "k", dueDate: "2026-11-02", text: "Soak rajma", forName: "Rajma", source: "recipe", slug: "r", index: 0, cookDate: "2026-11-03", coverDates: [] }] });
    const data = await getScheduleData(5);
    expect(data).toEqual({ plan: { title: "p" }, prep: [{ dueDate: "2026-11-02", text: "Soak rajma", forName: "Rajma" }] });
    expect(vi.mocked(buildNight).mock.calls[0]![0]).toMatchObject({ planId: 5, earliest: "2026-11-02" });
  });
});
