import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "./helpers/db";
import type { DbHandle } from "./helpers/db";
import * as s from "../lib/db/schema";
import { createMemoryStore } from "../lib/blob/memory";
import { writeRecipeFeedback } from "../lib/human/feedback";
import { writeSavedView } from "../lib/human/saved-views";
import { writeLink, updateLinkRow } from "../lib/human/links";
import { writePersonRoutine } from "../lib/human/routines";
import { approveCandidate, rejectCandidate, writeUploadedPhoto } from "../lib/human/photos";

let h: DbHandle;
let recipeId: number;
let personId: number;
let habitId: number;
let store: ReturnType<typeof createMemoryStore>;
const image = () => sharp({ create: { width: 64, height: 64, channels: 3, background: "#336699" } }).jpeg().toBuffer();

beforeEach(async () => {
  h = await openDb();
  store = createMemoryStore();
  const [recipe] = await h.db.insert(s.recipes).values({
    slug: "fixture", name: "Fixture", kind: "recipe", family: "test", mealSlots: [], cuisine: "test", isIndian: false,
    servings: 1, prepMin: 0, activeMin: 0, totalMin: 0, equipment: [], tags: [], fridgeDays: 1,
  }).returning({ id: s.recipes.id });
  recipeId = recipe!.id;
  const [person] = await h.db.insert(s.people).values({
    name: "Atomicity fixture", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70,
    activityLevel: "light", dietFlags: [],
  }).returning({ id: s.people.id });
  personId = person!.id;
  const [habit] = await h.db.insert(s.habits).values({
    slug: "fixture", title: "Fixture", category: "test", evidenceGrade: "practical", evidenceNote: "Fixture", defaultOn: false,
  }).returning({ id: s.habits.id });
  habitId = habit!.id;
});
afterEach(() => h.close());

const snapshot = async () => ({
  feedback: await h.db.select().from(s.recipeFeedback),
  views: await h.db.select().from(s.savedViews),
  links: await h.db.select().from(s.recipeLinks),
  routines: await h.db.select().from(s.personRoutines),
  photos: await h.db.select().from(s.photos),
  decisions: await h.db.select().from(s.photoDecisions),
  sync: await h.db.select().from(s.syncState),
});

const writes: Record<string, (update: boolean) => Promise<unknown>> = {
  feedback: async (update) => writeRecipeFeedback(h.db, recipeId, { notes: update ? "updated" : "first" }),
  views: async (update) => writeSavedView(h.db, { list: "recipes", query: update ? "time=10" : "time=20" }),
  links: async (update) => {
    if (!update) return writeLink(h.db, recipeId, { kind: "recipe", url: "https://example.com/fixture", title: "First" });
    const [link] = await h.db.select().from(s.recipeLinks);
    return updateLinkRow(h.db, link!.id, { title: "Updated" });
  },
  routines: async (update) => writePersonRoutine(h.db, personId, habitId, {
    active: true, days: [1], timeOfDay: "morning", servings: update ? 2 : 1,
  }),
  decisions: async (update) => rejectCandidate(h.db, {
    candidateKey: update ? "commons:second" : "commons:first", kind: "recipe", slug: "fixture",
  }),
  photos: async () => writeUploadedPhoto(h.db, store, { subject: { kind: "recipe", recipeId }, bytes: await image() }),
};

async function blockSync(operation: "insert" | "update") {
  await h.failWrite("sync_state", operation, "fail_sync");
}

describe.each(Object.keys(writes))("human-owned %s atomicity", (name) => {
  it("does not save data if its new sync marker cannot be inserted", async () => {
    const before = await snapshot();
    await blockSync("insert");
    await expect(writes[name]!(false)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    expect(store.size()).toBe(0);
    await h.dropFailure("sync_state", "fail_sync");
    await writes[name]!(false);
    expect(await h.db.select().from(s.syncState)).toHaveLength(1);
  });

  it("preserves existing data and sync metadata when the marker update fails", async () => {
    await writes[name]!(false);
    const before = await snapshot();
    const blobs = await store.list();
    await blockSync("update");
    await expect(writes[name]!(true)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    expect(await store.list()).toEqual(blobs);
  });
});

describe("candidate approval atomicity", () => {
  it("rolls back photo, approval and both sync markers when the second marker fails", async () => {
    await h.failWrite("sync_state", "insert", "fail_approval_sync", "NEW.data_class = 'photo-decisions'");
    const before = await snapshot();
    await expect(approveCandidate(h.db, store, {
      candidateKey: "commons:fixture", provider: "commons", subject: { kind: "recipe", recipeId },
      subjectSlug: "fixture", bytes: await image(), credit: { author: "Fixture", licence: "CC0 1.0" },
    })).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    expect(store.size()).toBe(0);
  });
});
