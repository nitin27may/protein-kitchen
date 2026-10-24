import { beforeEach, describe, expect, it, vi } from "vitest";
import { routeAccess } from "../lib/auth/access";
import { getDb } from "../lib/server/context";
import { getBlobStore } from "../lib/blob";
import { getPlanExport } from "../lib/server/export";
import { GET as exportPlan } from "../app/api/plan/[id]/export/route";
import { GET as photo } from "../app/photos/[uid]/[variant]/route";
import { GET as status, POST as subscribe } from "../app/api/push/subscribe/route";
import { POST as unsubscribe } from "../app/api/push/unsubscribe/route";
import { POST as testPush } from "../app/api/push/test/route";
import { deletePushSubscription, hasPushSubscription, personExists, savePushSubscription } from "../lib/server/subscriptions";
import { getPerson } from "../lib/server/queries";
import { sendToPerson, vapidConfigured } from "../lib/server/push";
import { buildWorkbook } from "../lib/export/xlsx";
import { buildPdf } from "../lib/export/pdf";
import { createMemoryStore } from "../lib/blob/memory";
import { openDb } from "./helpers/db";
import { photos } from "../lib/db/schema";
import { photoKeys } from "../lib/photos/keys";
import { buildPlanExport } from "../lib/export/model";
vi.mock("../lib/auth/access", () => ({ routeAccess: vi.fn() }));
vi.mock("../lib/server/context", () => ({ getDb: vi.fn() }));
vi.mock("../lib/blob", () => ({ getBlobStore: vi.fn() }));
vi.mock("../lib/server/export", () => ({ getPlanExport: vi.fn() }));
vi.mock("../lib/server/subscriptions", () => ({ deletePushSubscription: vi.fn(), hasPushSubscription: vi.fn(), personExists: vi.fn(), savePushSubscription: vi.fn() }));
vi.mock("../lib/server/queries", () => ({ getPerson: vi.fn() }));
vi.mock("../lib/server/push", () => ({ sendToPerson: vi.fn(), vapidConfigured: vi.fn() }));
vi.mock("../lib/export/xlsx", () => ({ buildWorkbook: vi.fn() }));
vi.mock("../lib/export/pdf", () => ({ buildPdf: vi.fn() }));

const origin = "https://kitchen.example.test";
const subscription = { personId: 5, endpoint: "https://push.example.test/device", keys: { p256dh: "synthetic-key-123", auth: "synthetic-auth-123" } };
const request = (body?: unknown, url = "/api/push/subscribe") => new Request(`${origin}${url}`, {
  method: body === undefined ? "GET" : "POST",
  headers: { origin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
});
const member = { userId: "cook", role: "member" as const, personId: 5 };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(routeAccess).mockResolvedValue({ member });
});
function uncached(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toContain("no-store");
}
describe("direct private route boundaries", () => {
  it.each([401, 403, 503])("returns %i before reading any private data", async (code) => {
    const denied = Response.json({ ok: false }, { status: code, headers: { "Cache-Control": "private, no-store" } });
    vi.mocked(routeAccess).mockResolvedValue({ response: denied });
    const req = request({});
    const responses = await Promise.all([
      exportPlan(req, { params: Promise.resolve({ id: "1" }) }),
      photo(req, { params: Promise.resolve({ uid: "private", variant: "thumb" }) }),
      status(request()), subscribe(req), unsubscribe(req), testPush(req),
    ]);
    for (const response of responses) uncached(response, code);
    for (const call of [getDb, getBlobStore, getPlanExport, getPerson, sendToPerson, savePushSubscription, hasPushSubscription, deletePushSubscription]) expect(call).not.toHaveBeenCalled();
  });
  it("binds every push operation to the session-linked profile", async () => {
    uncached(await subscribe(request({ ...subscription, personId: 6 })), 403);
    uncached(await testPush(request({ personId: 6 })), 403);
    uncached(await status(request(undefined, "/api/push/subscribe?personId=6&endpoint=private")), 403);
    expect(savePushSubscription).not.toHaveBeenCalled();
    expect(sendToPerson).not.toHaveBeenCalled();
    expect(hasPushSubscription).not.toHaveBeenCalled();
    vi.mocked(personExists).mockResolvedValue(true);
    vi.mocked(savePushSubscription).mockResolvedValue(true);
    uncached(await subscribe(request(subscription)), 200);
    expect(savePushSubscription).toHaveBeenCalledWith(5, { endpoint: subscription.endpoint, ...subscription.keys });
    expect(routeAccess).toHaveBeenLastCalledWith(expect.any(Request), true);
    vi.mocked(savePushSubscription).mockResolvedValue(false);
    uncached(await subscribe(request(subscription)), 409);
    vi.mocked(personExists).mockResolvedValue(false);
    uncached(await subscribe(request(subscription)), 404);
    vi.mocked(hasPushSubscription).mockResolvedValue(true);
    const result = await status(request(undefined, `/api/push/subscribe?personId=5&endpoint=${encodeURIComponent(subscription.endpoint)}`));
    uncached(result, 200);
    expect(await result.json()).toEqual({ subscribed: true });
    uncached(await unsubscribe(request({ endpoint: subscription.endpoint })), 200);
    expect(deletePushSubscription).toHaveBeenCalledWith(subscription.endpoint, 5);
  });
  it("rejects malformed push payloads and surfaces unavailable/undelivered reminders", async () => {
    for (const handler of [subscribe, unsubscribe, testPush]) {
      uncached(await handler(request({})), 400);
      uncached(await handler(new Request(`${origin}/api/push`, { method: "POST", body: "{" })), 400);
    }
    uncached(await testPush(request({ personId: 5 })), 503);
    vi.mocked(vapidConfigured).mockReturnValue(true);
    vi.mocked(getPerson).mockResolvedValue(undefined);
    uncached(await testPush(request({ personId: 5 })), 404);
    vi.mocked(getPerson).mockResolvedValue({
      id: 5, householdId: null, name: "Synthetic cook", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70, activityLevel: "light",
      proteinTargetG: null, proteinGPerKg: 1.2, kcalTarget: null, reminderTime: "21:00", reminderTimezone: null, dietFlags: [],
    });
    vi.mocked(sendToPerson).mockResolvedValue({ sent: 0, failed: 0, removed: 0 });
    uncached(await testPush(request({ personId: 5 })), 409);
    vi.mocked(sendToPerson).mockResolvedValue({ sent: 1, failed: 0, removed: 0 });
    uncached(await testPush(request({ personId: 5 })), 200);
  });
  it("never caches invalid export requests or a missing plan", async () => {
    uncached(await exportPlan(request(undefined, "/api/plan/no/export"), { params: Promise.resolve({ id: "no" }) }), 400);
    uncached(await exportPlan(request(undefined, "/api/plan/1/export?format=html"), { params: Promise.resolve({ id: "1" }) }), 400);
    vi.mocked(getPlanExport).mockResolvedValue(undefined);
    uncached(await exportPlan(request(undefined, "/api/plan/1/export?format=pdf"), { params: Promise.resolve({ id: "1" }) }), 404);
    expect(buildPdf).not.toHaveBeenCalled();
    expect(buildWorkbook).not.toHaveBeenCalled();
    uncached(await photo(request(), { params: Promise.resolve({ uid: "invalid", variant: "thumb" }) }), 404);
    expect(getBlobStore).not.toHaveBeenCalled();
  });
  it("serves only existing authorized photo variants, without reusable cache headers", async () => {
    const h = await openDb();
    try {
      const uid = "00000000-0000-4000-8000-000000000001";
      const store = createMemoryStore();
      vi.mocked(getDb).mockResolvedValue(h.db);
      vi.mocked(getBlobStore).mockReturnValue(store);
      const context = { params: Promise.resolve({ uid, variant: "thumb" }) };
      uncached(await photo(request(), context), 404);
      await h.db.insert(photos).values({
        uid, ingredientSlug: "synthetic", origin: "upload", sha256: "0".repeat(64), width: 1, height: 1,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      uncached(await photo(request(), context), 404);
      await store.put(photoKeys(uid).thumb, new Uint8Array([82, 73, 70, 70]), "image/webp");
      const response = await photo(request(), context);
      uncached(response, 200);
      expect(response.headers.get("content-type")).toBe("image/webp");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([82, 73, 70, 70]));
      uncached(await photo(request(), { params: Promise.resolve({ uid, variant: "original" }) }), 404);
    } finally { await h.close(); }
  });
  it("returns uncached export payloads and explicit builder failures", async () => {
    const plan = buildPlanExport({
      startDate: "2026-11-02", endDate: "2026-11-02", generatedOn: "2026-11-01", people: [], slots: [],
      recipes: new Map(), ingredients: new Map(), micros: {},
    });
    vi.mocked(getPlanExport).mockResolvedValue(plan);
    vi.mocked(buildWorkbook).mockResolvedValue(Buffer.from("PK-synthetic"));
    vi.mocked(buildPdf).mockResolvedValue(Buffer.from("%PDF-synthetic"));
    for (const format of ["xlsx", "pdf"]) {
      const result = await exportPlan(request(undefined, `/api/plan/1/export?format=${format}`), { params: Promise.resolve({ id: "1" }) });
      uncached(result, 200);
      expect(result.headers.get("content-disposition")).toContain(`.${format}"`);
    }
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(buildPdf).mockRejectedValue(new Error("synthetic export failure"));
    uncached(await exportPlan(request(undefined, "/api/plan/1/export?format=pdf"), { params: Promise.resolve({ id: "1" }) }), 500);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
