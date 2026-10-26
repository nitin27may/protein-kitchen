import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CreditsList } from "../components/photos/CreditsList";
import { PhotoCredit } from "../components/photos/PhotoCredit";
import { loadData } from "../lib/data/load";
import {
  libraryCredits, libraryHighlights, libraryIngredientCards, libraryIngredientDetail, libraryRecipeCards, libraryRecipeDetail,
} from "../lib/library/anonymous";
import { EMPTY_LIBRARY_MANIFEST, libraryView, safeHref, type LibraryPhotoEntry, type LibraryPhotoManifest } from "../lib/library-photos/model";

const data = loadData(process.cwd());
const entry = (uid: string, over: Partial<LibraryPhotoEntry> = {}): LibraryPhotoEntry => ({
  uid, w: 1280, h: 960, title: "Falafel", author: "A. Person", licence: "CC BY 4.0", licenceUrl: "https://creativecommons.org/licenses/by/4.0/",
  sourceUrl: "https://commons.example.test/f", origin: "commons", candidateKey: `commons:${uid}`, ...over,
});
const subject = (...uids: string[]) => ({ cover: entry(uids[0]!), photos: uids.map((u) => entry(u)) });
const slug = "tofu-burrito-bowl";
const ingredientSlugs = [...data.ingredients.keys()];
const full: LibraryPhotoManifest = {
  recipes: { [slug]: subject("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222") },
  ingredients: Object.fromEntries(ingredientSlugs.map((s, i) => [s, subject(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`)])),
};

describe("anonymous loaders with the library manifest", () => {
  it("look exactly as today when no manifest is passed or the manifest is empty", () => {
    expect(libraryRecipeCards(data, EMPTY_LIBRARY_MANIFEST)).toEqual(libraryRecipeCards(data));
    expect(libraryRecipeCards(data).every((c) => c.image === null && c.thumbs.length === 0)).toBe(true);
    expect(libraryIngredientCards(data).every((c) => c.image === null)).toBe(true);
    const detail = libraryRecipeDetail(data, slug)!;
    expect([detail.image, detail.photos, detail.thumbs]).toEqual([null, [], []]);
    expect(libraryIngredientDetail(data, "tofu-extra-firm")).toMatchObject({ cover: undefined, anonymous: true });
    expect(libraryHighlights(data, 3, EMPTY_LIBRARY_MANIFEST)).toEqual(libraryHighlights(data, 3));
    expect(libraryCredits(data)).toEqual([]);
  });

  it("put the recipe cover on cards and the detail page, with library URLs", () => {
    const card = libraryRecipeCards(data, full).find((c) => c.slug === slug)!;
    expect(card.image).toBe("/library-photos/11111111-1111-4111-8111-111111111111/thumb");
    const detail = libraryRecipeDetail(data, slug, full)!;
    expect(detail.image).toBe("/library-photos/11111111-1111-4111-8111-111111111111/master");
    expect(detail.photos.map((p) => [p.scope, p.isCover])).toEqual([["library", true], ["library", false]]);
    expect(libraryHighlights(data, 50, full).some((c) => c.image !== null)).toBe(true);
  });

  it("build the ingredient-photo collage only from 3 or more ingredient photos", () => {
    const card = libraryRecipeCards(data, full).find((c) => c.slug === slug)!;
    expect(card.thumbs.length).toBeGreaterThanOrEqual(3);
    expect(card.thumbs.every((t) => t.startsWith("/library-photos/"))).toBe(true);
    const two: LibraryPhotoManifest = { recipes: {}, ingredients: Object.fromEntries(Object.entries(full.ingredients).slice(0, 2)) };
    expect(libraryRecipeCards(data, two).every((c) => c.thumbs.length === 0)).toBe(true);
    expect(libraryRecipeDetail(data, slug, full)!.thumbs.length).toBeGreaterThanOrEqual(3);
  });

  it("show ingredient covers on cards and the detail page, and recipe covers on the ingredient page", () => {
    const tofu = libraryIngredientCards(data, full).find((c) => c.slug === "tofu-extra-firm")!;
    expect(tofu.image).toMatch(/^\/library-photos\/.+\/thumb$/);
    const detail = libraryIngredientDetail(data, "tofu-extra-firm", full);
    expect(detail.cover).toMatchObject({ scope: "library", url: expect.stringMatching(/\/master$/) });
    expect(detail.recipePhotos.get(slug)).toBe("/library-photos/11111111-1111-4111-8111-111111111111/thumb");
  });

  it("list credits with display names, sorted, and keep a removed subject's slug", () => {
    const manifest: LibraryPhotoManifest = { recipes: { [slug]: subject("11111111-1111-4111-8111-111111111111"), "gone-recipe": subject("33333333-3333-4333-8333-333333333333") }, ingredients: { "tofu-extra-firm": subject("44444444-4444-4444-8444-444444444444"), "gone-ing": subject("55555555-5555-4555-8555-555555555555") } };
    const rows = libraryCredits(data, manifest);
    expect(rows.map((r) => r.name)).toEqual(expect.arrayContaining([data.recipes.get(slug)!.name, "gone-recipe", "gone-ing"]));
    expect([...rows.map((r) => r.name)]).toEqual([...rows.map((r) => r.name)].sort((a, b) => a.localeCompare(b)));
    expect(rows.every((r) => r.scope === "library")).toBe(true);
  });
});

describe("credit rendering", () => {
  const row = (over = {}) => ({ uid: "u1", subjectKind: "recipe" as const, subjectSlug: slug, scope: "library" as const, name: "Tofu burrito bowl", title: "Falafel", author: "A. Person", licence: "CC BY 4.0", licenceUrl: "https://creativecommons.org/licenses/by/4.0/", sourceUrl: "https://commons.example.test/f", ...over });

  it("links the title to its source and the licence to its terms, and says when no credit is required", () => {
    const html = renderToStaticMarkup(createElement(CreditsList, { rows: [row(), row({ uid: "u2", licence: "CC0 1.0", licenceUrl: null, author: null, title: null, sourceUrl: null, subjectKind: "ingredient" })] }));
    expect(html).toContain('<a href="https://commons.example.test/f" target="_blank" rel="noreferrer" class="underline">Falafel</a>');
    expect(html).toContain('href="https://creativecommons.org/licenses/by/4.0/"');
    expect(html).toContain("A. Person");
    expect(html).toContain("unknown author");
    expect(html).toContain("CC0 1.0 (no credit required)");
    expect(html).toContain("Recipes (1)");
    expect(html).toContain("Ingredients (1)");
    expect(renderToStaticMarkup(createElement(CreditsList, { rows: [] }))).toContain("None yet.");
  });

  it("never renders a non-web link", () => {
    const html = renderToStaticMarkup(createElement(CreditsList, { rows: [row({ sourceUrl: "javascript:alert(1)", licenceUrl: "data:text/html,x" })] }));
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text");
    expect(safeHref("not a url")).toBeNull();
    expect(safeHref("https://x.test/a")).toBe("https://x.test/a");
  });

  it("shows the inline credit for a library photo, none for your own upload, and degrades without links", () => {
    const cover = libraryView(entry("66666666-6666-4666-8666-666666666666"), true);
    const html = renderToStaticMarkup(createElement(PhotoCredit, { cover }));
    expect(html).toContain("Photo:");
    expect(html).toContain('href="https://commons.example.test/f"');
    expect(html).toContain('href="/credits"');
    expect(renderToStaticMarkup(createElement(PhotoCredit, { cover: { ...cover, origin: "upload" } }))).toBe("");
    expect(renderToStaticMarkup(createElement(PhotoCredit, { cover: undefined }))).toBe("");
    const bare = renderToStaticMarkup(createElement(PhotoCredit, { cover: { ...cover, title: null, author: null, licence: null, sourceUrl: null, licenceUrl: null } }));
    expect(bare).toContain("Photo: unknown");
    const unlinked = renderToStaticMarkup(createElement(PhotoCredit, { cover: { ...cover, licenceUrl: null, sourceUrl: null } }));
    expect(unlinked).toContain("Falafel, A. Person, CC BY 4.0");
  });
});
