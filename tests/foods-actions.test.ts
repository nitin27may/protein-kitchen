import { eq } from "drizzle-orm";
import sharp from "sharp";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { archiveFood, attachLabelPhoto, createFood, deleteFood, restoreFood, updateFood } from "../app/foods/actions";
import { actionDenial, requireMember, AccessDenied } from "../lib/auth/access";
import { setBlobStore } from "../lib/blob";
import { createMemoryStore } from "../lib/blob/memory";
import * as s from "../lib/db/schema";
import { draftFromValues, emptyFormValues, type FoodFormValues } from "../lib/foods/form";
import { logFoodEntry } from "../lib/human/food-log";
import { foodLabelKeys } from "../lib/photos/keys";
import * as writers from "../lib/human/household-foods";
import { getDb } from "../lib/server/context";
import { getHouseholdFood } from "../lib/server/food-queries";
import { openDb, type DbHandle } from "./helpers/db";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../lib/auth/access", async (original) => ({ ...await original<typeof import("../lib/auth/access")>(), actionDenial: vi.fn(), requireMember: vi.fn() }));
vi.mock("../lib/server/context", () => ({ getDb: vi.fn() }));
vi.mock("../lib/human/household-foods", async (original) => {
  const actual = await original<typeof import("../lib/human/household-foods")>();
  return { ...actual, createHouseholdFood: vi.fn(actual.createHouseholdFood), archiveHouseholdFood: vi.fn(actual.archiveHouseholdFood) };
});

let h: DbHandle;
let store: ReturnType<typeof createMemoryStore>;
let role: "owner" | "member";

const OWNER = { userId: "owner-a", role: "owner" as const, personId: 1 };
const MEMBER = { userId: "member-a", role: "member" as const, personId: 3 };
const OTHER_OWNER = { userId: "owner-b", role: "owner" as const, personId: 2 };
const as = (m: { userId: string; role: "owner" | "member"; personId: number }) => { role = m.role; vi.mocked(requireMember).mockResolvedValue(m); };

const pancake = (over: Partial<FoodFormValues> = {}): FoodFormValues => ({
  ...emptyFormValues(), name: "Kirkland pancake batter", brand: "Kirkland Signature", servingSize: "55", servingLabel: "1/3 cup",
  energy: "190", protein: "5", carbs: "40", fat: "1.5", fibre: "1", sugars: "6", sodium: "480", ...over,
});
const jpeg = () => sharp({ create: { width: 1200, height: 800, channels: 3, background: "#406080" } }).jpeg().toBuffer();
async function form(values: FoodFormValues, opts: { checked?: boolean; photo?: Uint8Array | File | null } = {}) {
  const fd = new FormData();
  fd.set("save", JSON.stringify({ draft: draftFromValues(values).draft, checkedAgainstLabel: opts.checked ?? false }));
  if (opts.photo instanceof File) fd.set("photo", opts.photo);
  else if (opts.photo) fd.set("photo", new File([Buffer.from(opts.photo)], "label.jpg", { type: "image/jpeg" }));
  return fd;
}
const foods = () => h.db.select().from(s.householdFoods);
const photoFiles = () => store.list();

beforeEach(async () => {
  vi.resetAllMocks();
  const actual = await vi.importActual<typeof import("../lib/human/household-foods")>("../lib/human/household-foods");
  vi.mocked(writers.createHouseholdFood).mockImplementation(actual.createHouseholdFood);
  vi.mocked(writers.archiveHouseholdFood).mockImplementation(actual.archiveHouseholdFood);
  delete process.env.VERCEL_ENV;
  h = await openDb();
  store = createMemoryStore();
  setBlobStore(store);
  vi.mocked(getDb).mockResolvedValue(h.db);
  await h.db.insert(s.households).values([{ id: "a", name: "First" }, { id: "b", name: "Second" }]);
  await h.db.insert(s.people).values([
    { id: 1, householdId: "a", name: "Asha", sex: "female", birthDate: "1985-03-04", heightCm: 165, weightKg: 60, activityLevel: "light", dietFlags: [] },
    { id: 2, householdId: "b", name: "Ben", sex: "male", birthDate: "1984-01-02", heightCm: 180, weightKg: 80, activityLevel: "light", dietFlags: [] },
    { id: 3, householdId: "a", name: "Chen", sex: "male", birthDate: "1990-05-06", heightCm: 175, weightKg: 70, activityLevel: "light", dietFlags: [] },
  ]);
  await h.db.insert(s.authUsers).values(["owner-a", "member-a", "owner-b"].map((id) => ({ id, name: "Synthetic", email: `${id}@example.test`, emailVerified: true })));
  await h.db.insert(s.householdMembers).values([
    { userId: "owner-a", householdId: "a", personId: 1, role: "owner" },
    { userId: "member-a", householdId: "a", personId: 3, role: "member" },
    { userId: "owner-b", householdId: "b", personId: 2, role: "owner" },
  ]);
  vi.mocked(actionDenial).mockImplementation(async (policy) => (policy === "owner" && role !== "owner" ? { ok: false as const, error: "Only a household owner can do that." } : null));
  as(OWNER);
});
afterEach(() => { setBlobStore(null); delete process.env.VERCEL_ENV; });

describe("createFood", () => {
  it("stores the per-serving label converted to per 100 g, with provenance, when a label photo is attached", async () => {
    const r = await createFood(await form(pancake(), { photo: await jpeg() }));
    expect(r).toMatchObject({ ok: true, uid: expect.any(String) });
    const [row] = await foods();
    expect(row).toMatchObject({
      householdId: "a", name: "Kirkland pancake batter", brand: "Kirkland Signature", kcal: 345.5, proteinG: 9.09, carbsG: 72.73, fatG: 2.73, fibreG: 1.82,
      servingG: 55, servingLabel: "1/3 cup", labelBasis: "per_serving", source: "LABEL", createdByPersonId: 1, confirmedByPersonId: 1,
    });
    expect(row!.per100gMicros).toEqual({ sugars_g: 10.909, sodium_mg: 872.727 });
    expect(row!.fieldOrigins).toMatchObject({ kcal: "typed", proteinG: "typed" });
    expect(row!.confirmedAt).toBeTruthy();
    expect(row!.labelPhotoUid).toBeTruthy();
    expect(await photoFiles()).toEqual([foodLabelKeys(row!.labelPhotoUid!).master, foodLabelKeys(row!.labelPhotoUid!).thumb]);
    expect(revalidatePath).toHaveBeenCalledWith("/foods", "layout");
  });

  it("is MANUAL without a photo and keeps fibre not reported as null", async () => {
    expect(await createFood(await form(pancake({ fibre: "" })))).toMatchObject({ ok: true });
    const [row] = await foods();
    expect(row).toMatchObject({ source: "MANUAL", fibreG: null, labelPhotoUid: null });
    expect(await photoFiles()).toEqual([]);
  });

  it("converts the units on the server: a figure typed as the client preview shows is never trusted", async () => {
    const fd = new FormData();
    const draft = draftFromValues(pancake()).draft;
    fd.set("save", JSON.stringify({ draft: { ...draft, per100g: { kcal: 1, protein_g: 1, carbs_g: 1, fat_g: 1 } }, checkedAgainstLabel: false }));
    expect(await createFood(fd)).toMatchObject({ ok: false });
    expect(await foods()).toEqual([]);
  });

  it("refuses a hard error and writes nothing", async () => {
    const r = await createFood(await form(pancake({ protein: "60" })));
    expect(r).toMatchObject({ ok: false, fields: { protein_g: expect.any(String) } });
    expect(await createFood(await form(pancake({ name: "" })))).toMatchObject({ ok: false, fields: { name: "Enter a name." } });
    expect(await createFood(await form(pancake({ fat: "-1" })))).toMatchObject({ ok: false });
    expect(await createFood(await form(pancake({ energy: "795", energyUnit: "kcal" }), { checked: true }))).toMatchObject({ ok: false, error: expect.stringMatching(/950/) });
    expect(await foods()).toEqual([]);
  });

  it("refuses a warning until the label was checked, then accepts it", async () => {
    const batter = pancake({ energy: "377", protein: "2.5", carbs: "17", fat: "1", fibre: "0.5", sugars: "3", sodium: "230" });
    const refused = await createFood(await form(batter));
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/Check the highlighted values/), fields: { energy: expect.stringMatching(/kJ/) } });
    expect(await foods()).toEqual([]);
    expect(await createFood(await form(batter, { checked: true }))).toMatchObject({ ok: true });
    expect(await foods()).toHaveLength(1);
  });

  it("maps a duplicate barcode to a plain message", async () => {
    expect(await createFood(await form(pancake({ barcode: "96385074" })))).toMatchObject({ ok: true });
    expect(await createFood(await form(pancake({ name: "Other", barcode: "96385074" })))).toEqual({ ok: false, error: "You already have a food with this barcode." });
    expect(await foods()).toHaveLength(1);
  });

  it("refuses unreadable, forged and oversized requests", async () => {
    const bad = new FormData();
    expect(await createFood(bad)).toMatchObject({ ok: false });
    bad.set("save", "{not json");
    expect(await createFood(bad)).toMatchObject({ ok: false, error: expect.stringMatching(/could not be read/) });
    const extra = new FormData();
    extra.set("save", JSON.stringify({ draft: { ...draftFromValues(pancake()).draft, householdId: "b" }, checkedAgainstLabel: false }));
    expect(await createFood(extra)).toMatchObject({ ok: false, fields: expect.any(Object) });
    const empty = new FormData();
    empty.set("save", JSON.stringify({}));
    expect(await createFood(empty)).toMatchObject({ ok: false, fields: expect.any(Object) });
    const huge = new File([new Uint8Array(8 * 1024 * 1024 + 1)], "big.jpg", { type: "image/jpeg" });
    expect(await createFood(await form(pancake(), { photo: huge }))).toEqual({ ok: false, error: "That photo is larger than 8 MB." });
    expect(await foods()).toEqual([]);
  });

  it("takes the food back out when the photo is not an image, so no LABEL food is left without its photo", async () => {
    const notImage = new File([Buffer.from("not an image")], "label.jpg", { type: "image/jpeg" });
    const r = await createFood(await form(pancake(), { photo: notImage }));
    expect(r.ok).toBe(false);
    expect(await foods()).toEqual([]);
    expect(await photoFiles()).toEqual([]);
  });

  it("does not accept a photo in a preview deployment", async () => {
    process.env.VERCEL_ENV = "preview";
    expect(await createFood(await form(pancake(), { photo: await jpeg() }))).toEqual({ ok: false, error: "Photo changes are disabled in preview deployments." });
    expect(await createFood(await form(pancake()))).toMatchObject({ ok: true });
  });

  it("a member is refused before anything is read or written", async () => {
    as(MEMBER);
    expect(await createFood(await form(pancake(), { photo: await jpeg() }))).toEqual({ ok: false, error: "Only a household owner can do that." });
    expect(await foods()).toEqual([]);
    expect(await photoFiles()).toEqual([]);
  });

  it("reports a lost session in words", async () => {
    vi.mocked(requireMember).mockRejectedValue(new AccessDenied("Sign in before continuing.", 401));
    expect(await createFood(await form(pancake()))).toEqual({ ok: false, error: "Sign in before continuing." });
  });

  it("rethrows what it does not understand", async () => {
    vi.mocked(requireMember).mockRejectedValue(new Error("database is down"));
    await expect(createFood(await form(pancake()))).rejects.toThrow("database is down");
  });

  it("reports an owner whose profile is not finished", async () => {
    await h.db.update(s.householdMembers).set({ personId: null }).where(eq(s.householdMembers.userId, "owner-a"));
    vi.mocked(requireMember).mockResolvedValue({ userId: "owner-a", role: "owner", personId: 1 });
    expect(await createFood(await form(pancake()))).toMatchObject({ ok: false });
  });
});

describe("updateFood", () => {
  async function make(over: Partial<FoodFormValues> = {}, photo = false) {
    const r = await createFood(await form(pancake(over), photo ? { photo: await jpeg() } : {}));
    if (!r.ok) throw new Error(r.error);
    return r.uid;
  }

  it("replaces the confirmed record and says how many past entries it changes", async () => {
    const uid = await make();
    const row = (await getHouseholdFood(h.db, "a", uid))!;
    await logFoodEntry(h.db, { householdId: "a", personId: 1 }, { personId: 3, date: "2026-11-02", slot: "snack", kind: "extra", item: { type: "food", householdFoodUid: uid, grams: 110 } });
    expect(row.usageCount).toBe(0);
    const r = await updateFood(uid, await form(pancake({ protein: "6" })));
    expect(r).toEqual({ ok: true, uid, affectedEntries: 1 });
    expect((await getHouseholdFood(h.db, "a", uid))!.proteinG).toBe(10.91);
  });

  it("keeps LABEL while the food has a photo, and a typed food becomes LABEL when a photo is added in the edit", async () => {
    const labelled = await make({}, true);
    expect(await updateFood(labelled, await form(pancake({ protein: "6" })))).toMatchObject({ ok: true });
    expect((await getHouseholdFood(h.db, "a", labelled))!.source).toBe("LABEL");

    const typed = await make({ name: "Typed pancake mix", barcode: "" });
    expect((await getHouseholdFood(h.db, "a", typed))!.source).toBe("MANUAL");
    expect(await updateFood(typed, await form(pancake({ name: "Typed pancake mix" }), { photo: await jpeg() }))).toMatchObject({ ok: true });
    const after = (await getHouseholdFood(h.db, "a", typed))!;
    expect(after.source).toBe("LABEL");
    expect(after.hasLabelPhoto).toBe(true);
  });

  it("replaces the photo and deletes the old bytes", async () => {
    const uid = await make({}, true);
    const before = await photoFiles();
    expect(before).toHaveLength(2);
    await updateFood(uid, await form(pancake(), { photo: await jpeg() }));
    const after = await photoFiles();
    expect(after).toHaveLength(2);
    expect(after.some((k) => before.includes(k))).toBe(false);
  });

  it("refuses an unreadable photo without changing the food", async () => {
    const uid = await make();
    const notImage = new File([Buffer.from("nope")], "label.jpg", { type: "image/jpeg" });
    expect(await updateFood(uid, await form(pancake({ protein: "6" }), { photo: notImage }))).toMatchObject({ ok: false });
    expect((await getHouseholdFood(h.db, "a", uid))).toMatchObject({ proteinG: 9.09, source: "MANUAL" });
  });

  it("refuses hard errors, unconfirmed warnings, forged requests and previews", async () => {
    const uid = await make();
    expect(await updateFood(uid, await form(pancake({ carbs: "" })))).toMatchObject({ ok: false });
    expect(await updateFood(uid, new FormData())).toMatchObject({ ok: false });
    const huge = new File([new Uint8Array(8 * 1024 * 1024 + 1)], "big.jpg");
    expect(await updateFood(uid, await form(pancake(), { photo: huge }))).toMatchObject({ ok: false });
    process.env.VERCEL_ENV = "preview";
    expect(await updateFood(uid, await form(pancake(), { photo: await jpeg() }))).toEqual({ ok: false, error: "Photo changes are disabled in preview deployments." });
    expect(await updateFood("", await form(pancake()))).toMatchObject({ ok: false });
    expect(await updateFood("x".repeat(101), await form(pancake()))).toMatchObject({ ok: false });
  });

  it("maps a barcode that another food has", async () => {
    await make({ barcode: "96385074" });
    const other = await make({ name: "Second food" });
    expect(await updateFood(other, await form(pancake({ name: "Second food", barcode: "96385074" })))).toEqual({ ok: false, error: "You already have a food with this barcode." });
  });

  it("refuses a member, and another household's uid, without touching either", async () => {
    const uid = await make({}, true);
    as(MEMBER);
    expect(await updateFood(uid, await form(pancake({ protein: "6" })))).toEqual({ ok: false, error: "Only a household owner can do that." });
    as(OTHER_OWNER);
    expect(await updateFood(uid, await form(pancake({ protein: "6" }), { photo: await jpeg() }))).toEqual({ ok: false, error: "That food is not in your household." });
    const row = (await getHouseholdFood(h.db, "a", uid))!;
    expect(row.proteinG).toBe(9.09);
    expect(await photoFiles()).toHaveLength(2);
  });

  it("an update that loses a race with a delete reports the food as missing", async () => {
    const uid = await make();
    const fd = await form(pancake({ protein: "6" }));
    await h.db.delete(s.householdFoods).where(eq(s.householdFoods.uid, uid));
    expect(await updateFood(uid, fd)).toEqual({ ok: false, error: "That food is not in your household." });
  });
});

describe("archive, restore, delete", () => {
  async function make() {
    const r = await createFood(await form(pancake(), { photo: await jpeg() }));
    if (!r.ok) throw new Error(r.error);
    return r.uid;
  }

  it("archives and restores a food", async () => {
    const uid = await make();
    expect(await archiveFood(uid)).toEqual({ ok: true });
    expect((await getHouseholdFood(h.db, "a", uid))!.archived).toBe(true);
    expect(await restoreFood(uid)).toEqual({ ok: true });
    expect((await getHouseholdFood(h.db, "a", uid))!.archived).toBe(false);
  });

  it("deletes an unused food and its photo; refuses a used one", async () => {
    const used = await make();
    await logFoodEntry(h.db, { householdId: "a", personId: 1 }, { personId: 3, date: "2026-11-02", slot: "snack", kind: "extra", item: { type: "food", householdFoodUid: used, grams: 50 } });
    expect(await deleteFood(used)).toEqual({ ok: false, error: "This food is in the food log, so it cannot be deleted. Archive it instead." });
    const unused = (await createFood(await form(pancake({ name: "Unused" })))) as { uid: string };
    expect(await deleteFood(unused.uid)).toEqual({ ok: true });
    expect(await foods()).toHaveLength(1);
    await h.db.delete(s.foodLog);
    expect(await deleteFood(used)).toEqual({ ok: true });
    expect(await foods()).toEqual([]);
    expect(await photoFiles()).toEqual([]);
  });

  it("reports leftover photo files without failing the delete", async () => {
    const uid = await make();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(store, "delete").mockRejectedValue(new Error("storage down"));
    expect(await deleteFood(uid)).toEqual({ ok: true });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/left files behind/), { count: 2 });
    log.mockRestore();
  });

  it("refuses a member and another household, and a bad uid", async () => {
    const uid = await make();
    for (const action of [archiveFood, restoreFood, deleteFood]) {
      as(MEMBER);
      expect(await action(uid)).toEqual({ ok: false, error: "Only a household owner can do that." });
      as(OTHER_OWNER);
      expect(await action(uid)).toEqual({ ok: false, error: "That food is not in your household." });
      expect(await action("")).toEqual({ ok: false, error: "That food is not in your household." });
    }
    expect(await foods()).toHaveLength(1);
    expect((await getHouseholdFood(h.db, "a", uid))!.archived).toBe(false);
    expect(await photoFiles()).toHaveLength(2);
  });
});

describe("attachLabelPhoto", () => {
  const photoForm = async (bytes?: Uint8Array) => { const fd = new FormData(); if (bytes) fd.set("photo", new File([Buffer.from(bytes)], "label.jpg", { type: "image/jpeg" })); return fd; };

  it("replaces the photo of a labelled food and removes the old bytes", async () => {
    const created = await createFood(await form(pancake(), { photo: await jpeg() })) as { uid: string };
    const before = await photoFiles();
    expect(await attachLabelPhoto(created.uid, await photoForm(await jpeg()))).toEqual({ ok: true, uid: created.uid });
    const after = await photoFiles();
    expect(after).toHaveLength(2);
    expect(after.some((k) => before.includes(k))).toBe(false);
  });

  it("sends a typed food to Edit, so its numbers are checked against the label", async () => {
    const created = await createFood(await form(pancake())) as { uid: string };
    expect(await attachLabelPhoto(created.uid, await photoForm(await jpeg()))).toMatchObject({ ok: false, error: expect.stringMatching(/from Edit/) });
    expect(await photoFiles()).toEqual([]);
  });

  it("refuses no photo, a bad photo, a preview, a member and another household", async () => {
    const created = await createFood(await form(pancake(), { photo: await jpeg() })) as { uid: string };
    expect(await attachLabelPhoto(created.uid, await photoForm())).toEqual({ ok: false, error: "Choose a photo first." });
    const huge = new File([new Uint8Array(8 * 1024 * 1024 + 1)], "big.jpg");
    const hugeForm = new FormData(); hugeForm.set("photo", huge);
    expect(await attachLabelPhoto(created.uid, hugeForm)).toEqual({ ok: false, error: "That photo is larger than 8 MB." });
    expect(await attachLabelPhoto(created.uid, await photoForm(Buffer.from("nope")))).toMatchObject({ ok: false });
    expect(await attachLabelPhoto("", await photoForm(await jpeg()))).toMatchObject({ ok: false });
    process.env.VERCEL_ENV = "preview";
    expect(await attachLabelPhoto(created.uid, await photoForm(await jpeg()))).toEqual({ ok: false, error: "Photo changes are disabled in preview deployments." });
    delete process.env.VERCEL_ENV;
    as(MEMBER);
    expect(await attachLabelPhoto(created.uid, await photoForm(await jpeg()))).toEqual({ ok: false, error: "Only a household owner can do that." });
    as(OTHER_OWNER);
    expect(await attachLabelPhoto(created.uid, await photoForm(await jpeg()))).toEqual({ ok: false, error: "That food is not in your household." });
    expect(await photoFiles()).toHaveLength(2);
  });
});

describe("what is not the person's doing", () => {
  it("says plainly what a writer refused, and rethrows what it does not understand", async () => {
    for (const [code, text] of [["person-not-found", "Finish your household profile before continuing."], ["invalid", "The food is not valid."], ["archived", "That food is archived."]] as const) {
      vi.mocked(writers.createHouseholdFood).mockRejectedValueOnce(new writers.FoodDataError(code, text));
      expect(await createFood(await form(pancake()))).toEqual({ ok: false, error: text });
    }
    vi.mocked(writers.archiveHouseholdFood).mockRejectedValueOnce(new Error("database is down"));
    await expect(archiveFood("anything")).rejects.toThrow("database is down");
  });

  it("an unreadable root value and an empty photo field are handled", async () => {
    const root = new FormData();
    root.set("save", "5");
    expect(await createFood(root)).toMatchObject({ ok: false, fields: { form: expect.any(String) } });
    const empty = await form(pancake(), { photo: new File([], "empty.jpg") });
    expect(await createFood(empty)).toMatchObject({ ok: true });
    expect((await foods())[0]!.source).toBe("MANUAL");
  });

  it("takes the food back out when storage fails while saving the photo, then rethrows", async () => {
    vi.spyOn(store, "put").mockRejectedValue(new Error("storage down"));
    await expect(createFood(await form(pancake(), { photo: await jpeg() }))).rejects.toThrow("storage down");
    expect(await foods()).toEqual([]);
  });

  it("still fails cleanly when the food cannot be taken back out", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const notImage = new File([Buffer.from("nope")], "label.jpg", { type: "image/jpeg" });
    await h.db.insert(s.households).values({ id: "c", name: "Third" });
    // The food is in the log by the time the photo fails: deleting it is refused.
    vi.mocked(writers.createHouseholdFood).mockImplementationOnce(async (db, scope, input) => {
      const made = await (await vi.importActual<typeof import("../lib/human/household-foods")>("../lib/human/household-foods")).createHouseholdFood(db, scope, input);
      await logFoodEntry(db, scope, { personId: 3, date: "2026-11-02", slot: "snack", kind: "extra", item: { type: "food", householdFoodUid: made.uid, grams: 10 } });
      return made;
    });
    expect((await createFood(await form(pancake(), { photo: notImage }))).ok).toBe(false);
    expect(log).toHaveBeenCalledWith("A food saved without its label photo could not be removed.");
    log.mockRestore();
  });

  it("logs, but does not fail on, old photo files that could not be deleted when a photo is replaced", async () => {
    const created = await createFood(await form(pancake(), { photo: await jpeg() })) as { uid: string };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(store, "delete").mockRejectedValue(new Error("storage down"));
    expect(await updateFood(created.uid, await form(pancake(), { photo: await jpeg() }))).toMatchObject({ ok: true });
    expect(log).toHaveBeenCalledWith("Label photo storage cleanup left files behind.", { count: 2 });
    log.mockRestore();
  });
});
