import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/foods/[uid]/label/[variant]/route";
import { routeAccess } from "../lib/auth/access";
import { setBlobStore } from "../lib/blob";
import { createMemoryStore } from "../lib/blob/memory";
import * as s from "../lib/db/schema";
import { attachFoodLabelPhoto, createHouseholdFood } from "../lib/human/household-foods";
import { foodLabelKeys } from "../lib/photos/keys";
import { memberHouseholdAccess } from "../lib/auth/household-access";
import { getDb } from "../lib/server/context";
import sharp from "sharp";
import { openDb } from "./helpers/db";

vi.mock("../lib/auth/access", async (original) => ({ ...await original<typeof import("../lib/auth/access")>(), routeAccess: vi.fn() }));
vi.mock("../lib/server/context", () => ({ getDb: vi.fn() }));
vi.mock("../lib/auth/household-access", async (original) => ({ ...await original<typeof import("../lib/auth/household-access")>(), memberHouseholdAccess: vi.fn() }));

let store: ReturnType<typeof createMemoryStore>;
let uid: string;
let photoUid: string;
const OWNER_A = { userId: "owner-a", role: "owner" as const, personId: 1 };
const params = (u: string, variant: string) => ({ params: Promise.resolve({ uid: u, variant }) });
const get = (u: string, variant = "master") => GET(new Request(`http://127.0.0.1/foods/${u}/label/${variant}`), params(u, variant));

beforeEach(async () => {
  vi.resetAllMocks();
  const real = await vi.importActual<typeof import("../lib/auth/household-access")>("../lib/auth/household-access");
  vi.mocked(memberHouseholdAccess).mockImplementation(real.memberHouseholdAccess);
  const h = await openDb();
  store = createMemoryStore();
  setBlobStore(store);
  vi.mocked(getDb).mockResolvedValue(h.db);
  await h.db.insert(s.households).values([{ id: "a", name: "First" }, { id: "b", name: "Second" }]);
  await h.db.insert(s.people).values([
    { id: 1, householdId: "a", name: "Asha", sex: "female", birthDate: "1985-03-04", heightCm: 165, weightKg: 60, activityLevel: "light", dietFlags: [] },
    { id: 2, householdId: "b", name: "Ben", sex: "male", birthDate: "1984-01-02", heightCm: 180, weightKg: 80, activityLevel: "light", dietFlags: [] },
  ]);
  await h.db.insert(s.authUsers).values(["owner-a", "owner-b"].map((id) => ({ id, name: "Synthetic", email: `${id}@example.test`, emailVerified: true })));
  await h.db.insert(s.householdMembers).values([
    { userId: "owner-a", householdId: "a", personId: 1, role: "owner" },
    { userId: "owner-b", householdId: "b", personId: 2, role: "owner" },
  ]);
  const created = await createHouseholdFood(h.db, { householdId: "a", personId: 1 }, {
    name: "Pancake batter", kcal: 345, proteinG: 9, carbsG: 72, fatG: 2.7, labelBasis: "per_100g", source: "LABEL",
  });
  uid = created.uid;
  const jpeg = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#406080" } }).jpeg().toBuffer();
  photoUid = (await attachFoodLabelPhoto(h.db, store, { householdId: "a", personId: 1 }, uid, jpeg)).labelPhotoUid;
  vi.mocked(routeAccess).mockResolvedValue({ member: OWNER_A });
});

describe("GET /foods/[uid]/label/[variant]", () => {
  it("serves the household's own label photo as private WebP", async () => {
    for (const variant of ["master", "thumb"]) {
      const res = await get(uid, variant);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/webp");
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(Buffer.from(await res.arrayBuffer()).subarray(8, 12).toString()).toBe("WEBP");
    }
  });

  it("is a 404 for another household's food, with no hint that it exists", async () => {
    vi.mocked(routeAccess).mockResolvedValue({ member: { userId: "owner-b", role: "owner", personId: 2 } });
    const res = await get(uid);
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await res.text()).toBe("Not found");
  });

  it("is a 404 for a missing food, a food without a photo, an unknown variant and a vanished file", async () => {
    expect((await get("missing")).status).toBe(404);
    expect((await get(uid, "original")).status).toBe(404);
    await store.delete(foodLabelKeys(photoUid).master);
    expect((await get(uid)).status).toBe(404);
    const h = await getDb();
    const bare = await createHouseholdFood(h, { householdId: "a", personId: 1 }, { name: "No photo", kcal: 1, proteinG: 0, carbsG: 0, fatG: 0, labelBasis: "per_100g", source: "MANUAL" });
    expect((await get(bare.uid)).status).toBe(404);
  });

  it("returns the access response untouched when the caller is not signed in", async () => {
    vi.mocked(routeAccess).mockResolvedValue({ response: Response.json({ ok: false }, { status: 401 }) });
    expect((await get(uid)).status).toBe(401);
  });

  it("says the household is not available when membership cannot be resolved, and rethrows anything else", async () => {
    vi.mocked(routeAccess).mockResolvedValue({ member: { userId: "nobody", role: "owner", personId: 9 } });
    const res = await get(uid);
    expect(res.status).toBe(403);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    vi.mocked(memberHouseholdAccess).mockRejectedValueOnce(new Error("down"));
    await expect(get(uid)).rejects.toThrow("down");
  });
});
