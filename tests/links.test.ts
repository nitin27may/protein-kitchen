import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { loadData } from "../lib/data/load";
import { openDb } from "./helpers/db";
import type { DbHandle } from "./helpers/db";
import { seedDatabase } from "../lib/db/seed";
import * as s from "../lib/db/schema";
import { applyRenames } from "../lib/db/renames";
import { deleteLinkRow, exportHumanData, importHumanData, reorderLinks, updateLinkRow, writeLink } from "../lib/human";
import { parseLinkUrl, parseStartSeconds, normaliseSource, normaliseStartSec, normaliseTitle } from "../lib/links/url";
import type { LinkInput } from "../lib/links/types";
import { addLinkChecked, MAX_LINKS_PER_RECIPE, moveLinkChecked, removeLinkChecked, updateLinkChecked } from "../lib/server/link-actions";
import { recipeLinksFor } from "../lib/server/link-view";
import { resetCounts, resetData } from "../lib/server/reset";

const root = path.resolve(__dirname, "..");
const data = loadData(root);
let h: DbHandle;

const input = (over: Partial<LinkInput> = {}): LinkInput => ({
  recipeSlug: "falafel-bowl",
  kind: "video",
  url: "https://example.com/falafel",
  title: "How to bake falafel",
  ...over,
});
const syncOf = async (cls: string) => (await h.db.select().from(s.syncState).where(eq(s.syncState.dataClass, cls)))[0];
const recipeId = async (slug: string) => (await h.db.select({ id: s.recipes.id }).from(s.recipes).where(eq(s.recipes.slug, slug)))[0]!.id;

beforeEach(async () => {
  h = await openDb();
  await seedDatabase(h.db, data);
});

describe("parseLinkUrl", () => {
  const ok = (text: string) => {
    const r = parseLinkUrl(text);
    if (!r.ok) throw new Error(`expected ok for ${text}: ${r.error}`);
    return r.value;
  };
  const bad = (text: string) => {
    const r = parseLinkUrl(text);
    if (r.ok) throw new Error(`expected a rejection for ${text}`);
    return r.error;
  };

  it("accepts a normal https link and lowercases the host", () => {
    const v = ok("  https://Example.COM/recipes/falafel  ");
    expect(v.url).toBe("https://example.com/recipes/falafel");
    expect(v.host).toBe("example.com");
    expect(v.embed).toBeNull();
  });

  it.each([
    ["http://example.com/a", "Use an https link"],
    ["javascript:alert(1)", "Use an https link"],
    ["data:text/html,hi", "Use an https link"],
    ["file:///etc/passwd", "Use an https link"],
    ["ftp://example.com/a", "Use an https link"],
  ])("rejects %s", (text, message) => {
    expect(bad(text)).toBe(message);
  });

  it("rejects credentials, local hosts, IP addresses and private ranges", () => {
    expect(bad("https://user:pass@example.com/a")).toMatch(/username/);
    expect(bad("https://user@example.com/a")).toMatch(/username/);
    for (const host of ["localhost", "app.localhost", "printer.local", "intranet", "127.0.0.1", "10.0.0.5", "192.168.1.20", "169.254.169.254", "[::1]", "2130706433", "0x7f000001"]) {
      expect(bad(`https://${host}/a`)).toMatch(/public website/);
    }
  });

  it("rejects an empty, malformed or very long link", () => {
    expect(bad("")).toMatch(/Paste a link/);
    expect(bad("not a link")).toMatch(/full address/);
    expect(bad(`https://example.com/${"a".repeat(2100)}`)).toMatch(/too long/);
  });

  it("strips tracking parameters and an empty fragment, keeps the rest", () => {
    const v = ok("https://example.com/r?utm_source=x&utm_medium=y&fbclid=1&gclid=2&si=3&igshid=4&mc_cid=5&mc_eid=6&ref=7&feature=8&page=2&q=falafel#");
    expect(v.url).toBe("https://example.com/r?page=2&q=falafel");
    expect(ok("https://example.com/r?utm_source=x#").url).toBe("https://example.com/r");
    expect(ok("https://example.com/r#step-2").url).toBe("https://example.com/r#step-2");
  });

  it("embeds YouTube watch links, short links and shorts, with the start time", () => {
    const watch = ok("https://www.youtube.com/watch?v=dQw4w9WgXcQ&utm_source=x&si=abc");
    expect(watch.embed).toEqual({ provider: "youtube", src: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", startSec: null });
    expect(watch.url).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");

    expect(ok("https://youtu.be/dQw4w9WgXcQ?t=90").embed).toEqual({ provider: "youtube", src: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90", startSec: 90 });
    expect(ok("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s").embed?.startSec).toBe(90);
    expect(ok("https://m.youtube.com/watch?v=dQw4w9WgXcQ&start=1h2m3s").embed?.startSec).toBe(3723);
    expect(ok("https://youtube.com/shorts/dQw4w9WgXcQ").embed?.src).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
  });

  it("embeds Vimeo links", () => {
    expect(ok("https://vimeo.com/123456789").embed).toEqual({ provider: "vimeo", src: "https://player.vimeo.com/video/123456789", startSec: null });
    expect(ok("https://vimeo.com/123456789#t=1m30s").embed).toEqual({ provider: "vimeo", src: "https://player.vimeo.com/video/123456789#t=90s", startSec: 90 });
  });

  it("does not embed look-alike hosts, bad ids or other pages on the same site", () => {
    expect(ok("https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ").embed).toBeNull();
    expect(ok("https://evil-youtube.com/watch?v=dQw4w9WgXcQ").embed).toBeNull();
    expect(ok("https://notyoutu.be/dQw4w9WgXcQ").embed).toBeNull();
    expect(ok("https://youtu.be.evil.example/dQw4w9WgXcQ").embed).toBeNull();
    expect(ok("https://www.youtube.com/watch?v=short").embed).toBeNull();
    expect(ok("https://www.youtube.com/watch?v=dQw4w9WgXcQ%22%3E%3Cscript%3E").embed).toBeNull();
    expect(ok("https://www.youtube.com/playlist?list=PL123").embed).toBeNull();
    expect(ok("https://vimeo.com.evil.example/123456789").embed).toBeNull();
    expect(ok("https://vimeo.com/channels/staffpicks").embed).toBeNull();
    expect(ok("https://vimeo.com/12").embed).toBeNull();
  });

  it("reads start times in the forms people paste", () => {
    expect(parseStartSeconds("90")).toBe(90);
    expect(parseStartSeconds("90s")).toBe(90);
    expect(parseStartSeconds("1m30s")).toBe(90);
    expect(parseStartSeconds("2h")).toBe(7200);
    expect(parseStartSeconds("1h2m3s")).toBe(3723);
    expect(parseStartSeconds("")).toBeNull();
    expect(parseStartSeconds("soon")).toBeNull();
    expect(parseStartSeconds("-5")).toBeNull();
    expect(parseStartSeconds("99999999")).toBeNull();
    expect(parseStartSeconds(null)).toBeNull();
  });

  it("checks title, source and start time", () => {
    expect(normaliseTitle("  Baked   falafel \n bowl ")).toEqual({ ok: true, value: "Baked falafel bowl" });
    expect(normaliseTitle("   ").ok).toBe(false);
    expect(normaliseTitle("x".repeat(80)).ok).toBe(true);
    expect(normaliseTitle("x".repeat(81)).ok).toBe(false);
    expect(normaliseSource("  ")).toEqual({ ok: true, value: null });
    expect(normaliseSource("Hebbars Kitchen")).toEqual({ ok: true, value: "Hebbars Kitchen" });
    expect(normaliseSource("x".repeat(61)).ok).toBe(false);
    expect(normaliseStartSec(null)).toEqual({ ok: true, value: null });
    expect(normaliseStartSec(0)).toEqual({ ok: true, value: 0 });
    expect(normaliseStartSec(86400)).toEqual({ ok: true, value: 86400 });
    expect(normaliseStartSec(86401).ok).toBe(false);
    expect(normaliseStartSec(1.5).ok).toBe(false);
    expect(normaliseStartSec(-1).ok).toBe(false);
  });
});

describe("link rows", () => {
  it("writeLink stamps a uid and timestamps, appends the position, and marks the data class changed", async () => {
    const id = await recipeId("falafel-bowl");
    const first = await writeLink(h.db, id, { kind: "recipe", url: "https://example.com/a", title: "A" });
    const second = await writeLink(h.db, id, { kind: "video", url: "https://example.com/b", title: "B", partSlug: "hummus", stepNo: 1, source: "Channel", startSec: 30 });
    expect(first.uid).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.uid).not.toBe(first.uid);
    const rows = await h.db.select().from(s.recipeLinks).where(eq(s.recipeLinks.recipeId, id));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(first.id)!.position).toBe(0);
    expect(byId.get(second.id)!.position).toBe(1);
    expect(byId.get(second.id)).toMatchObject({ partSlug: "hummus", stepNo: 1, source: "Channel", startSec: 30, kind: "video" });
    expect(byId.get(first.id)!.createdAt).toBe(byId.get(first.id)!.updatedAt);
    expect((await syncOf("recipe-links"))?.changedAt).toBeTruthy();
  });

  it("updateLinkRow changes the fields but keeps uid, position and created_at", async () => {
    const id = await recipeId("falafel-bowl");
    const { id: linkId, uid } = await writeLink(h.db, id, { kind: "recipe", url: "https://example.com/a", title: "A" });
    const before = (await h.db.select().from(s.recipeLinks).where(eq(s.recipeLinks.id, linkId)))[0]!;
    await new Promise((r) => setTimeout(r, 5));
    expect(await updateLinkRow(h.db, linkId, { title: "New title", stepNo: 2 })).toBe(true);
    const after = (await h.db.select().from(s.recipeLinks).where(eq(s.recipeLinks.id, linkId)))[0]!;
    expect(after).toMatchObject({ title: "New title", stepNo: 2, uid, position: before.position, createdAt: before.createdAt, url: before.url });
    expect(after.updatedAt > before.updatedAt).toBe(true);
    expect(await updateLinkRow(h.db, 99999, { title: "x" })).toBe(false);
  });

  it("deleteLinkRow removes the link and marks the class changed", async () => {
    const id = await recipeId("falafel-bowl");
    const { id: linkId } = await writeLink(h.db, id, { kind: "recipe", url: "https://example.com/a", title: "A" });
    expect(await deleteLinkRow(h.db, linkId)).toBe(true);
    expect(await deleteLinkRow(h.db, linkId)).toBe(false);
    expect(await h.db.select().from(s.recipeLinks)).toHaveLength(0);
  });

  it("reorderLinks rewrites positions, ignores foreign ids and keeps unnamed links after the named ones", async () => {
    const id = await recipeId("falafel-bowl");
    const other = await recipeId("palak-paneer");
    const a = await writeLink(h.db, id, { kind: "recipe", url: "https://example.com/a", title: "A" });
    const b = await writeLink(h.db, id, { kind: "recipe", url: "https://example.com/b", title: "B" });
    const c = await writeLink(h.db, id, { kind: "recipe", url: "https://example.com/c", title: "C" });
    const foreign = await writeLink(h.db, other, { kind: "recipe", url: "https://example.com/z", title: "Z" });
    await reorderLinks(h.db, id, [c.id, foreign.id, a.id]);
    const links = await recipeLinksFor(h.db, "falafel-bowl");
    expect(links.map((l) => l.title)).toEqual(["C", "A", "B"]);
    expect(links.map((l) => l.position)).toEqual([0, 1, 2]);
    expect((await recipeLinksFor(h.db, "palak-paneer"))[0]!.position).toBe(0);
    expect(b.id).toBeGreaterThan(0);
  });
});

describe("link actions (validation)", () => {
  it("adds a valid link and returns its id", async () => {
    const r = await addLinkChecked(h.db, data.recipes, input());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.recipeSlug).toBe("falafel-bowl");
    expect(await h.db.select().from(s.recipeLinks)).toHaveLength(1);
  });

  it("stores the cleaned URL and title", async () => {
    await addLinkChecked(h.db, data.recipes, input({ url: "https://Example.com/falafel?utm_source=x", title: "  Bake   falafel  ", source: "  Kitchen  " }));
    const [row] = await h.db.select().from(s.recipeLinks);
    expect(row).toMatchObject({ url: "https://example.com/falafel", title: "Bake falafel", source: "Kitchen" });
  });

  it("explains an unusable link in plain words, per field", async () => {
    const http = await addLinkChecked(h.db, data.recipes, input({ url: "http://example.com/a" }));
    expect(http).toEqual({ ok: false, error: "Use an https link", fields: { url: "Use an https link" } });
    const noTitle = await addLinkChecked(h.db, data.recipes, input({ title: " " }));
    expect(noTitle.ok).toBe(false);
    if (!noTitle.ok) expect(noTitle.fields).toHaveProperty("title");
    const badStart = await addLinkChecked(h.db, data.recipes, input({ startSec: 100000 }));
    if (!badStart.ok) expect(badStart.fields).toHaveProperty("startSec");
    expect(badStart.ok).toBe(false);
    const badKind = await addLinkChecked(h.db, data.recipes, { ...input(), kind: "podcast" as never });
    expect(badKind.ok).toBe(false);
  });

  it("rejects an unknown recipe", async () => {
    const r = await addLinkChecked(h.db, data.recipes, input({ recipeSlug: "no-such-recipe" }));
    expect(r.ok).toBe(false);
  });

  it("rejects a duplicate URL on the same recipe but allows it on another", async () => {
    await addLinkChecked(h.db, data.recipes, input());
    const dup = await addLinkChecked(h.db, data.recipes, input({ title: "Same again" }));
    expect(dup).toEqual({ ok: false, error: "That link is already saved on this recipe", fields: { url: "That link is already saved on this recipe" } });
    const dupTracked = await addLinkChecked(h.db, data.recipes, input({ url: "https://example.com/falafel?utm_source=x" }));
    expect(dupTracked.ok).toBe(false);
    expect((await addLinkChecked(h.db, data.recipes, input({ recipeSlug: "palak-paneer" }))).ok).toBe(true);
  });

  it("caps a recipe at 12 links", async () => {
    for (let i = 0; i < MAX_LINKS_PER_RECIPE; i++) {
      expect((await addLinkChecked(h.db, data.recipes, input({ url: `https://example.com/v${i}`, title: `V${i}` }))).ok).toBe(true);
    }
    const over = await addLinkChecked(h.db, data.recipes, input({ url: "https://example.com/one-more" }));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toMatch(/up to 12 links/);
    expect((await addLinkChecked(h.db, data.recipes, input({ recipeSlug: "palak-paneer" }))).ok).toBe(true);
  });

  it("accepts a part of the meal and rejects one that is not", async () => {
    expect((await addLinkChecked(h.db, data.recipes, input({ partSlug: "hummus", url: "https://example.com/h" }))).ok).toBe(true);
    const notUsed = await addLinkChecked(h.db, data.recipes, input({ partSlug: "salsa-fresca", url: "https://example.com/s" }));
    expect(notUsed).toEqual({ ok: false, error: "That part is not part of this meal", fields: { partSlug: "That part is not part of this meal" } });
    const notAPart = await addLinkChecked(h.db, data.recipes, input({ partSlug: "palak-paneer", url: "https://example.com/p" }));
    expect(notAPart.ok).toBe(false);
    const unknown = await addLinkChecked(h.db, data.recipes, input({ partSlug: "nope", url: "https://example.com/n" }));
    expect(unknown.ok).toBe(false);
  });

  it("checks the step number against the meal or the part", async () => {
    expect((await addLinkChecked(h.db, data.recipes, input({ stepNo: 3, url: "https://example.com/s3" }))).ok).toBe(true); // falafel-bowl has 3 steps
    const tooHigh = await addLinkChecked(h.db, data.recipes, input({ stepNo: 4, url: "https://example.com/s4" }));
    expect(tooHigh).toEqual({ ok: false, error: "Choose a step from 1 to 3", fields: { stepNo: "Choose a step from 1 to 3" } });
    expect((await addLinkChecked(h.db, data.recipes, input({ stepNo: 0, url: "https://example.com/s0" }))).ok).toBe(false);
    expect((await addLinkChecked(h.db, data.recipes, input({ stepNo: 1.5, url: "https://example.com/sx" }))).ok).toBe(false);
    // baked-falafel has 4 steps, hummus 2
    expect((await addLinkChecked(h.db, data.recipes, input({ partSlug: "baked-falafel", stepNo: 4, url: "https://example.com/b4" }))).ok).toBe(true);
    const hummus3 = await addLinkChecked(h.db, data.recipes, input({ partSlug: "hummus", stepNo: 3, url: "https://example.com/h3" }));
    if (!hummus3.ok) expect(hummus3.error).toBe("Choose a step from 1 to 2");
    expect(hummus3.ok).toBe(false);
  });

  it("updates a link, keeps it on its recipe, and rejects a duplicate of another link", async () => {
    const a = await addLinkChecked(h.db, data.recipes, input({ url: "https://example.com/a", title: "A" }));
    const b = await addLinkChecked(h.db, data.recipes, input({ url: "https://example.com/b", title: "B" }));
    if (!a.ok || !b.ok) throw new Error("setup failed");
    expect((await updateLinkChecked(h.db, data.recipes, a.id, input({ url: "https://example.com/a", title: "A renamed" }))).ok).toBe(true); // own URL is not a duplicate
    expect((await recipeLinksFor(h.db, "falafel-bowl"))[0]!.title).toBe("A renamed");
    const dup = await updateLinkChecked(h.db, data.recipes, a.id, input({ url: "https://example.com/b" }));
    expect(dup.ok).toBe(false);
    const moved = await updateLinkChecked(h.db, data.recipes, a.id, input({ recipeSlug: "palak-paneer", url: "https://example.com/a" }));
    expect(moved.ok).toBe(false);
    expect((await updateLinkChecked(h.db, data.recipes, 99999, input())).ok).toBe(false);
  });

  it("removes a link and moves it up and down, stopping at the ends", async () => {
    const ids: number[] = [];
    for (const t of ["A", "B", "C"]) {
      const r = await addLinkChecked(h.db, data.recipes, input({ url: `https://example.com/${t}`, title: t }));
      if (r.ok) ids.push(r.id);
    }
    const titles = async () => (await recipeLinksFor(h.db, "falafel-bowl")).map((l) => l.title);
    await moveLinkChecked(h.db, ids[2]!, "up");
    expect(await titles()).toEqual(["A", "C", "B"]);
    await moveLinkChecked(h.db, ids[0]!, "up"); // already first
    expect(await titles()).toEqual(["A", "C", "B"]);
    await moveLinkChecked(h.db, ids[1]!, "down"); // already last
    expect(await titles()).toEqual(["A", "C", "B"]);
    await moveLinkChecked(h.db, ids[0]!, "down");
    expect(await titles()).toEqual(["C", "A", "B"]);
    expect((await removeLinkChecked(h.db, ids[1]!)).ok).toBe(true);
    expect(await titles()).toEqual(["C", "A"]);
    expect((await removeLinkChecked(h.db, ids[1]!)).ok).toBe(false);
    expect((await moveLinkChecked(h.db, 99999, "up")).ok).toBe(false);
  });
});

describe("recipeLinksFor", () => {
  it("orders by part (meal first), then step (whole first), then position, and works out embeds", async () => {
    const id = await recipeId("falafel-bowl");
    const w = (over: Parameters<typeof writeLink>[2]) => writeLink(h.db, id, over);
    await w({ kind: "video", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90", title: "Hummus video", partSlug: "hummus" });
    await w({ kind: "article", url: "https://example.com/step2", title: "Meal step 2", stepNo: 2 });
    await w({ kind: "recipe", url: "https://example.com/whole-b", title: "Meal whole B" });
    await w({ kind: "video", url: "https://vimeo.com/123456789", title: "Falafel step 3", partSlug: "baked-falafel", stepNo: 3 });
    await w({ kind: "recipe", url: "https://example.com/whole-a", title: "Meal whole A" });
    await w({ kind: "recipe", url: "https://example.com/falafel-whole", title: "Falafel whole", partSlug: "baked-falafel" });
    const links = await recipeLinksFor(h.db, "falafel-bowl");
    expect(links.map((l) => l.title)).toEqual(["Meal whole B", "Meal whole A", "Meal step 2", "Falafel whole", "Falafel step 3", "Hummus video"]);
    expect(links.find((l) => l.title === "Hummus video")!.embed).toEqual({ provider: "youtube", src: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90", startSec: 90 });
    expect(links.find((l) => l.title === "Falafel step 3")!.embed?.provider).toBe("vimeo");
    expect(links.find((l) => l.title === "Meal step 2")!.embed).toBeNull();
    expect(links.every((l) => typeof l.id === "number" && l.uid.length > 0)).toBe(true);
    expect(await recipeLinksFor(h.db, "palak-paneer")).toEqual([]);
    expect(await recipeLinksFor(h.db, "no-such-recipe")).toEqual([]);
  });
});

describe("export and import", () => {
  async function fill(db: DbHandle["db"]) {
    const id = (await db.select({ id: s.recipes.id }).from(s.recipes).where(eq(s.recipes.slug, "falafel-bowl")))[0]!.id;
    const other = (await db.select({ id: s.recipes.id }).from(s.recipes).where(eq(s.recipes.slug, "palak-paneer")))[0]!.id;
    await writeLink(db, id, { kind: "video", url: "https://youtu.be/dQw4w9WgXcQ", title: "Bowl video", source: "Channel", startSec: 30 });
    await writeLink(db, id, { kind: "recipe", url: "https://example.com/hummus", title: "Hummus recipe", partSlug: "hummus", stepNo: 1 });
    await writeLink(db, other, { kind: "article", url: "https://example.com/palak", title: "Palak notes" });
  }

  it("writes one file per recipe, in position order, with no database ids", async () => {
    await fill(h.db);
    const bundle = await exportHumanData(h.db);
    const paths = Object.keys(bundle.files).filter((p) => p.startsWith("links/"));
    expect(paths).toEqual(["links/falafel-bowl.json", "links/palak-paneer.json"]);
    const bowl = JSON.parse(bundle.files["links/falafel-bowl.json"]!);
    expect(bowl.slug).toBe("falafel-bowl");
    expect(bowl.links.map((l: { title: string }) => l.title)).toEqual(["Bowl video", "Hummus recipe"]);
    for (const p of paths) {
      const text = bundle.files[p]!;
      expect(text).not.toMatch(/"(id|recipe_id|recipeId)"/);
      expect(text.endsWith("\n")).toBe(true);
    }
    expect(bundle.manifest.tables["recipe-links"]!.count).toBe(2);
  });

  it("round trips into a fresh database byte for byte and importing twice changes nothing", async () => {
    await fill(h.db);
    const first = await exportHumanData(h.db);

    const b = await openDb();
    await seedDatabase(b.db, data);
    const report = await importHumanData(b.db, first, { renames: {} });
    expect(report.imported["recipe-links"]).toBe(3);
    expect(report.skipped).toEqual([]);
    const second = await exportHumanData(b.db);
    const linkFiles = (bundle: typeof first) => Object.fromEntries(Object.entries(bundle.files).filter(([p]) => p.startsWith("links/")));
    expect(linkFiles(second)).toEqual(linkFiles(first));
    expect(second.manifest.tables["recipe-links"]).toEqual(first.manifest.tables["recipe-links"]);

    await importHumanData(b.db, first, { renames: {} });
    expect(await b.db.select().from(s.recipeLinks)).toHaveLength(3);
    expect(linkFiles(await exportHumanData(b.db))).toEqual(linkFiles(first));
  });

  it("skips a file whose recipe is gone and has no rename, and follows a rename", async () => {
    await fill(h.db);
    const bundle = await exportHumanData(h.db);
    const b = await openDb();
    await seedDatabase(b.db, data);
    const renamed = { ...bundle, files: { ...bundle.files } };
    renamed.files["links/old-name.json"] = bundle.files["links/palak-paneer.json"]!.replace('"palak-paneer"', '"old-name"');
    delete renamed.files["links/palak-paneer.json"];
    const without = await importHumanData(b.db, renamed, { renames: {} });
    expect(without.skipped).toContain("links/old-name.json");
    const withRename = await importHumanData(b.db, renamed, { renames: { "old-name": "palak-paneer" } });
    expect(withRename.skipped).not.toContain("links/old-name.json");
    expect(await recipeLinksFor(b.db, "palak-paneer")).toHaveLength(1);
  });
});

describe("renames", () => {
  async function tinyRecipe(db: DbHandle["db"], slug: string): Promise<number> {
    const [row] = await db
      .insert(s.recipes)
      .values({ slug, name: slug, kind: "recipe", family: "bowls", mealSlots: ["lunch"], cuisine: "indian", isIndian: true, servings: 2, prepMin: 5, activeMin: 10, totalMin: 15, equipment: [], tags: [], fridgeDays: 2 })
      .returning({ id: s.recipes.id });
    return row!.id;
  }

  it("keeps links when both recipe rows exist: they move to the new slug and the old row can go", async () => {
    const c = await openDb();
    const oldId = await tinyRecipe(c.db, "old-bowl");
    const newId = await tinyRecipe(c.db, "new-bowl");
    await writeLink(c.db, newId, { kind: "recipe", url: "https://example.com/existing", title: "Existing" });
    await writeLink(c.db, oldId, { kind: "video", url: "https://example.com/v1", title: "V1" });
    await writeLink(c.db, oldId, { kind: "video", url: "https://example.com/v2", title: "V2" });
    const result = await applyRenames(c.db, { "old-bowl": "new-bowl" });
    expect(result.moved).toEqual(["old-bowl"]);
    expect((await recipeLinksFor(c.db, "new-bowl")).map((l) => l.title)).toEqual(["Existing", "V1", "V2"]);
    expect(await recipeLinksFor(c.db, "old-bowl")).toEqual([]);
    expect((await c.db.select().from(s.recipes).where(eq(s.recipes.slug, "old-bowl"))).length).toBe(0);
    expect(await applyRenames(c.db, { "old-bowl": "new-bowl" })).toEqual({ moved: [] }); // idempotent
    expect(await c.db.select().from(s.recipeLinks)).toHaveLength(3);
  });

  it("keeps links when the new slug is not seeded yet: the row is renamed in place", async () => {
    const c = await openDb();
    const oldId = await tinyRecipe(c.db, "old-bowl");
    await writeLink(c.db, oldId, { kind: "video", url: "https://example.com/v1", title: "V1" });
    await applyRenames(c.db, { "old-bowl": "new-bowl" });
    expect((await recipeLinksFor(c.db, "new-bowl")).map((l) => l.title)).toEqual(["V1"]);
  });
});

describe("reset", () => {
  it("'Everything' deletes links and counts them; the ratings reset leaves them alone", async () => {
    const id = await recipeId("falafel-bowl");
    await writeLink(h.db, id, { kind: "recipe", url: "https://example.com/a", title: "A" });
    await writeLink(h.db, id, { kind: "video", url: "https://example.com/b", title: "B" });
    expect((await resetCounts(h.db)).links).toBe(2);

    await resetData(h.db, "ratings");
    expect((await resetCounts(h.db)).links).toBe(2);
    await resetData(h.db, "plans");
    await resetData(h.db, "profiles");
    await resetData(h.db, "groceries");
    await resetData(h.db, "progress");
    expect((await resetCounts(h.db)).links).toBe(2);

    const before = (await syncOf("recipe-links"))!;
    await new Promise((r) => setTimeout(r, 5));
    await resetData(h.db, "all");
    expect((await resetCounts(h.db)).links).toBe(0);
    expect(await h.db.select().from(s.recipeLinks)).toHaveLength(0);
    expect((await syncOf("recipe-links"))!.changedAt > before.changedAt).toBe(true);
  });

  it("deleting a recipe row removes its links", async () => {
    const [row] = await h.db
      .insert(s.recipes)
      .values({ slug: "temp-recipe", name: "t", kind: "recipe", family: "bowls", mealSlots: ["lunch"], cuisine: "indian", isIndian: true, servings: 2, prepMin: 5, activeMin: 10, totalMin: 15, equipment: [], tags: [], fridgeDays: 2 })
      .returning({ id: s.recipes.id });
    await writeLink(h.db, row!.id, { kind: "recipe", url: "https://example.com/t", title: "T" });
    await h.db.delete(s.recipes).where(eq(s.recipes.id, row!.id));
    expect(await h.db.select().from(s.recipeLinks)).toHaveLength(0);
  });
});
