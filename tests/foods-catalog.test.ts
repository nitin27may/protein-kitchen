import { describe, expect, it } from "vitest";
import {
  buildCatalog,
  findDuplicates,
  householdKey,
  isValidGtin,
  nearKey,
  normalizeBarcode,
  parseFoodKey,
  searchCatalog,
  toGtin14,
} from "@/lib/foods/catalog";

const EAN13 = "4006381333931";
const UPCA = "036000291452";
const EAN8 = "96385074";
const GTIN14 = "10012345678902";

const library = [
  { slug: "paneer", name: "Paneer", aliases: ["cottage cheese", "chhena"], aisle: "dairy" },
  { slug: "rolled-oats", name: "Rolled oats", aliases: ["oatmeal"] },
  { slug: "chickpeas-dry", name: "Chickpeas, dry", aliases: ["chana", "garbanzo"] },
];
const household = [
  { uid: "u1", name: "Pancake mix", brand: "Kirkland Signature", barcode: EAN13, aliases: ["pancakes"] },
  { uid: "u2", name: "Oat milk", brand: "Silk", barcode: null },
  { uid: "u3", name: "Greek yogurt 0%", brand: null },
];
const catalog = buildCatalog(library, household);
const names = (items: { name: string }[]) => items.map((i) => i.name);

describe("GTIN", () => {
  it("accepts valid 8, 12, 13 and 14 digit codes", () => {
    for (const c of [EAN8, UPCA, EAN13, GTIN14]) expect(isValidGtin(c), c).toBe(true);
  });
  it("accepts spaces and hyphens", () => expect(isValidGtin("4006381 333931")).toBe(true));
  it("rejects a wrong check digit, wrong length and non-digits", () => {
    expect(isValidGtin("4006381333932")).toBe(false);
    expect(isValidGtin("123456789")).toBe(false);
    expect(isValidGtin("ABC38133393")).toBe(false);
    expect(isValidGtin("")).toBe(false);
  });
  it("check digit 0 works", () => expect(isValidGtin("4006381333900")).toBe(true));
  it("normalises and pads to GTIN-14", () => {
    expect(normalizeBarcode(" 4006-3813 33931 ")).toBe(EAN13);
    expect(toGtin14(UPCA)).toBe("00036000291452");
    expect(toGtin14(`0${UPCA}`)).toBe("00036000291452");
    expect(toGtin14("nope")).toBeUndefined();
  });
});

describe("keys", () => {
  it("household keys carry the hf: prefix, which no kebab-case slug can have", () => {
    expect(householdKey("abc")).toBe("hf:abc");
    expect(catalog.filter((i) => i.source === "household").every((i) => i.key.startsWith("hf:"))).toBe(true);
    expect(library.every((l) => /^[a-z0-9-]+$/.test(l.slug))).toBe(true);
  });
  it("parses both kinds", () => {
    expect(parseFoodKey("hf:u1")).toEqual({ source: "household", uid: "u1" });
    expect(parseFoodKey("paneer")).toEqual({ source: "library", slug: "paneer" });
  });
});

describe("buildCatalog", () => {
  it("merges library and household, storing barcodes as GTIN-14", () => {
    expect(catalog).toHaveLength(6);
    expect(catalog.find((i) => i.key === "hf:u1")).toMatchObject({ brand: "Kirkland Signature", barcode: "04006381333931", aliases: ["pancakes"] });
    expect(catalog.find((i) => i.key === "paneer")).toMatchObject({ source: "library", aisle: "dairy" });
    expect(catalog.find((i) => i.key === "hf:u2")?.barcode).toBeUndefined();
    expect(catalog.find((i) => i.key === "hf:u3")?.brand).toBeUndefined();
  });
  it("drops an invalid stored barcode instead of keeping garbage", () => {
    const c = buildCatalog([], [{ uid: "x", name: "X", barcode: "123", aisle: "pantry" }]);
    expect(c[0]).toMatchObject({ aisle: "pantry" });
    expect(c[0]?.barcode).toBeUndefined();
  });
});

describe("searchCatalog", () => {
  it("finds by name, case and accent folded", () => {
    expect(names(searchCatalog(catalog, "PANEER"))).toEqual(["Paneer"]);
    expect(names(searchCatalog(catalog, "chickpeas"))).toEqual(["Chickpeas, dry"]);
  });
  it("finds by brand", () => {
    expect(names(searchCatalog(catalog, "kirkland"))).toEqual(["Pancake mix"]);
    expect(names(searchCatalog(catalog, "silk oat"))).toEqual(["Oat milk"]);
  });
  it("finds by alias", () => {
    expect(names(searchCatalog(catalog, "chana"))).toEqual(["Chickpeas, dry"]);
    expect(names(searchCatalog(catalog, "cottage"))).toEqual(["Paneer"]);
    expect(names(searchCatalog(catalog, "pancakes"))).toEqual(["Pancake mix"]);
  });
  it("matches word starts and substrings, all words required", () => {
    expect(names(searchCatalog(catalog, "pan"))).toEqual(expect.arrayContaining(["Paneer", "Pancake mix"]));
    expect(names(searchCatalog(catalog, "ancake"))).toEqual(["Pancake mix"]);
    expect(searchCatalog(catalog, "paneer pancake")).toEqual([]);
  });
  it("ranks exact name above word-start above substring", () => {
    const c = buildCatalog([{ slug: "oat", name: "Oat" }, { slug: "oat-bran", name: "Oat bran" }, { slug: "goat", name: "Goat cheese" }], []);
    expect(names(searchCatalog(c, "oat"))).toEqual(["Oat", "Oat bran", "Goat cheese"]);
  });
  it("a brand match ranks below the same name match", () => {
    const c = buildCatalog([], [{ uid: "a", name: "Silk" }, { uid: "b", name: "Oat milk", brand: "Silk" }]);
    expect(names(searchCatalog(c, "silk"))).toEqual(["Silk", "Oat milk"]);
  });
  it("matches an exact barcode in any valid form, and nothing else", () => {
    expect(names(searchCatalog(catalog, EAN13))).toEqual(["Pancake mix"]);
    expect(names(searchCatalog(catalog, "4006381 333931"))).toEqual(["Pancake mix"]);
    expect(names(searchCatalog(catalog, `0${EAN13}`))).toEqual(["Pancake mix"]);
  });
  it("an unknown valid barcode falls back to text search and finds nothing", () => {
    expect(searchCatalog(catalog, UPCA)).toEqual([]);
  });
  it("empty query lists most used first, then by name", () => {
    const now = new Date("2026-10-26T12:00:00Z");
    const usage = {
      "hf:u1": { count: 3, lastLoggedAt: "2026-10-25T12:00:00Z" },
      paneer: { count: 30, lastLoggedAt: "2026-01-01T00:00:00Z" },
      "rolled-oats": { count: 1 },
      "hf:u3": { count: 1, lastLoggedAt: "not a date" },
    };
    expect(names(searchCatalog(catalog, "  ", { usage, now, limit: 4 }))).toEqual(["Paneer", "Pancake mix", "Greek yogurt 0%", "Rolled oats"]);
  });
  it("recent and frequent foods win ties within the same relevance", () => {
    const c = buildCatalog([{ slug: "oats-a", name: "Oats A" }, { slug: "oats-b", name: "Oats B" }], []);
    expect(names(searchCatalog(c, "oats"))).toEqual(["Oats A", "Oats B"]);
    expect(names(searchCatalog(c, "oats", { usage: { "oats-b": { count: 5 } } }))).toEqual(["Oats B", "Oats A"]);
  });
  it("usage cannot lift a weaker match above a stronger one", () => {
    const c = buildCatalog([{ slug: "oat", name: "Oat" }, { slug: "goat", name: "Goat" }], []);
    const usage = { goat: { count: 100, lastLoggedAt: "2026-10-25T00:00:00Z" } };
    expect(names(searchCatalog(c, "oat", { usage, now: new Date("2026-10-26T00:00:00Z") }))).toEqual(["Oat", "Goat"]);
  });
  it("respects the limit and returns nothing for punctuation-only queries", () => {
    expect(searchCatalog(catalog, "a", { limit: 2 })).toHaveLength(2);
    expect(searchCatalog(catalog, "!!!")).toEqual([]);
  });
  it("default limit is 20", () => {
    const many = buildCatalog(Array.from({ length: 30 }, (_, i) => ({ slug: `f-${i}`, name: `Food ${i}` })), []);
    expect(searchCatalog(many, "food")).toHaveLength(20);
    expect(searchCatalog(many, "")).toHaveLength(20);
  });
  it("exact barcode hits respect the limit", () => {
    const twins = buildCatalog([], [{ uid: "a", name: "A", barcode: EAN13 }, { uid: "b", name: "B", barcode: EAN13 }]);
    expect(searchCatalog(twins, EAN13, { limit: 1 })).toHaveLength(1);
  });
});

describe("dedupe", () => {
  it("same barcode is the same product, whatever the name", () => {
    const r = findDuplicates({ name: "Hotcake powder", barcode: `0${EAN13}` }, catalog);
    expect(r.barcodeMatch?.key).toBe("hf:u1");
    expect(r.warning).toBe('This barcode is already saved as "Pancake mix".');
  });
  it("near-match on name and brand returns a warning", () => {
    const r = findDuplicates({ name: "pancake  MIX", brand: "Kirkland signature" }, catalog);
    expect(r.barcodeMatch).toBeUndefined();
    expect(r.nearMatches.map((i) => i.key)).toEqual(["hf:u1"]);
    expect(r.warning).toMatch(/^Looks like "Pancake mix"/);
  });
  it("ignores word order and filler words", () => {
    expect(findDuplicates({ name: "Mix of the pancake", brand: "Kirkland Signature" }, catalog).nearMatches).toHaveLength(1);
  });
  it("a different product is not a near match", () => {
    const r = findDuplicates({ name: "Pancake syrup", brand: "Kirkland Signature" }, catalog);
    expect(r.nearMatches).toEqual([]);
    expect(r.warning).toBeUndefined();
  });
  it("a different brand of the same name is not a near match", () => {
    expect(findDuplicates({ name: "Oat milk", brand: "Oatly" }, catalog).nearMatches).toEqual([]);
  });
  it("matches library items by name", () => {
    expect(findDuplicates({ name: "Paneer" }, catalog).nearMatches.map((i) => i.key)).toEqual(["paneer"]);
  });
  it("barcode match is not repeated as a near match", () => {
    const r = findDuplicates({ name: "Pancake mix", brand: "Kirkland Signature", barcode: EAN13 }, catalog);
    expect(r.barcodeMatch?.key).toBe("hf:u1");
    expect(r.nearMatches).toEqual([]);
  });
  it("an invalid or unknown barcode is not a match; empty names never match", () => {
    expect(findDuplicates({ name: "Zzz", barcode: "123" }, catalog).barcodeMatch).toBeUndefined();
    expect(findDuplicates({ name: "Zzz", barcode: UPCA }, catalog).barcodeMatch).toBeUndefined();
    expect(findDuplicates({ name: "  " }, catalog)).toEqual({ nearMatches: [] });
  });
  it("nearKey is sorted unique words", () => {
    expect(nearKey("Mix of pancake pancake", "Kirkland")).toEqual(["kirkland", "mix", "pancake"]);
  });
});

describe("purity", () => {
  it("the pure food modules import no server, db, auth, human, blob or next code", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["catalog", "units", "validate", "diet-screen", "totals"]) {
      const src = readFileSync(`lib/foods/${f}.ts`, "utf8");
      const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] as string);
      expect(imports.filter((i) => /(^|\/)(server|db|auth|human|blob)(\/|$)|^next(\/|$)/.test(i)), f).toEqual([]);
    }
  });
});
