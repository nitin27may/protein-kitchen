import { describe, expect, it } from "vitest";
import type { RecipeLinkView } from "../lib/links/types";
import {
  collectLinks,
  cookSheetGroups,
  describeStartTime,
  describeTarget,
  flattenParts,
  joinStartTime,
  linksForCookStep,
  looksLikeVideoUrl,
  partLinks,
  splitStartTime,
  stepLinks,
  wholeLinks,
  withAutoplay,
} from "../lib/recipes/linkview";
import type { OwnedLink } from "../lib/recipes/linkview";
import type { PartView } from "../lib/recipes/timeline";

let nextId = 1;
const link = (over: Partial<RecipeLinkView> = {}): RecipeLinkView => ({
  id: nextId++,
  uid: `uid-${nextId}`,
  kind: "video",
  url: "https://example.com/a",
  title: "A link",
  source: null,
  startSec: null,
  partSlug: null,
  stepNo: null,
  position: 0,
  embed: null,
  ...over,
});

const part = (slug: string, steps: number, children: PartView[] = []): PartView =>
  ({ slug, name: slug.toUpperCase(), steps: Array.from({ length: steps }, () => ({ text: "x", cue: null, tip: null, timerSec: null })), children }) as unknown as PartView;

describe("collectLinks", () => {
  it("marks the meal's own links with the meal as owner", () => {
    const out = collectLinks("falafel-bowl", [link({ title: "Bowl video" })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.ownerSlug).toBe("falafel-bowl");
    expect(out[0]!.partSlug).toBeNull();
  });

  it("treats a link saved on a part's page as belonging to that part", () => {
    const out = collectLinks("falafel-bowl", [], { hummus: [link({ title: "Hummus video", position: 1 })] });
    expect(out[0]).toMatchObject({ ownerSlug: "hummus", partSlug: "hummus", stepNo: null });
  });

  it("keeps the step number of a link saved on a part's page", () => {
    const out = collectLinks("falafel-bowl", [], { hummus: [link({ stepNo: 2 })] });
    expect(out[0]).toMatchObject({ ownerSlug: "hummus", partSlug: "hummus", stepNo: 2 });
  });

  it("ignores a part entry that is the meal itself", () => {
    expect(collectLinks("hummus", [link()], { hummus: [link()] })).toHaveLength(1);
  });
});

describe("grouping and ordering", () => {
  const all: OwnedLink[] = collectLinks(
    "falafel-bowl",
    [
      link({ id: 10, title: "whole b", position: 2 }),
      link({ id: 11, title: "whole a", position: 1 }),
      link({ id: 12, title: "meal step 1", stepNo: 1, position: 3 }),
      link({ id: 13, title: "hummus on meal", partSlug: "hummus", position: 4 }),
      link({ id: 14, title: "hummus step 2 on meal", partSlug: "hummus", stepNo: 2, position: 5 }),
    ],
    { hummus: [link({ id: 20, title: "hummus own page", position: 1 }), link({ id: 21, title: "hummus own step 1", stepNo: 1, position: 2 })] },
  );

  it("returns whole-recipe links in position order and leaves out parts and steps", () => {
    expect(wholeLinks(all).map((l) => l.title)).toEqual(["whole a", "whole b"]);
  });

  it("returns a part's links from the meal and from the part's own page, meal-level first", () => {
    expect(partLinks(all, "hummus").map((l) => l.title)).toEqual(["hummus on meal", "hummus own page"]);
  });

  it("returns the links for one step of the meal", () => {
    expect(stepLinks(all, null, 1).map((l) => l.title)).toEqual(["meal step 1"]);
    expect(stepLinks(all, null, 2)).toEqual([]);
  });

  it("returns the links for one step of a part from both pages", () => {
    expect(stepLinks(all, "hummus", 2).map((l) => l.title)).toEqual(["hummus step 2 on meal"]);
    expect(stepLinks(all, "hummus", 1).map((l) => l.title)).toEqual(["hummus own step 1"]);
  });

  it("breaks position ties by id so the order is stable", () => {
    const tied = collectLinks("m", [link({ id: 9, title: "second", position: 0 }), link({ id: 3, title: "first", position: 0 })]);
    expect(wholeLinks(tied).map((l) => l.title)).toEqual(["first", "second"]);
  });
});

describe("linksForCookStep", () => {
  const links = collectLinks("falafel-bowl", [link({ title: "bake video", partSlug: "baked-falafel", stepNo: 4 }), link({ title: "assemble", stepNo: 1 })]);

  it("matches the part and the step number", () => {
    expect(linksForCookStep(links, "baked-falafel", 4).map((l) => l.title)).toEqual(["bake video"]);
  });

  it("does not match the same step number in another part or in the meal", () => {
    expect(linksForCookStep(links, "hummus", 4)).toEqual([]);
    expect(linksForCookStep(links, null, 4)).toEqual([]);
  });

  it("matches a step of the meal itself with a null part", () => {
    expect(linksForCookStep(links, null, 1).map((l) => l.title)).toEqual(["assemble"]);
  });
});

describe("cookSheetGroups", () => {
  it("groups whole-recipe links under the meal and part links under each part, skipping step links and empty parts", () => {
    const links = collectLinks("m", [link({ title: "whole" }), link({ title: "step", stepNo: 1 }), link({ title: "h", partSlug: "hummus" })]);
    const groups = cookSheetGroups(links, "Falafel bowl", [
      { slug: "hummus", name: "Hummus", stepCount: 2 },
      { slug: "tahini", name: "Tahini", stepCount: 1 },
    ]);
    expect(groups.map((g) => [g.name, g.links.map((l) => l.title)])).toEqual([
      ["Falafel bowl", ["whole"]],
      ["Hummus", ["h"]],
    ]);
  });

  it("returns nothing when there are no links", () => {
    expect(cookSheetGroups([], "M", [])).toEqual([]);
  });
});

describe("flattenParts", () => {
  it("lists parts and nested parts in reading order with their step counts", () => {
    const flat = flattenParts([part("a", 3, [part("a1", 2)]), part("b", 1)]);
    expect(flat).toEqual([
      { slug: "a", name: "A", stepCount: 3 },
      { slug: "a1", name: "A1", stepCount: 2 },
      { slug: "b", name: "B", stepCount: 1 },
    ]);
  });
});

describe("describeStartTime", () => {
  it.each([
    [null, null],
    [undefined, null],
    [0, null],
    [-5, null],
    [5, "0:05"],
    [59, "0:59"],
    [60, "1:00"],
    [150, "2:30"],
    [3599, "59:59"],
    [3600, "1:00:00"],
    [3723, "1:02:03"],
  ])("formats %s as %s", (input, expected) => {
    expect(describeStartTime(input as number | null | undefined)).toBe(expected);
  });
});

describe("start time editing", () => {
  it("splits seconds into minutes and seconds", () => {
    expect(splitStartTime(150)).toEqual({ min: "2", sec: "30" });
    expect(splitStartTime(null)).toEqual({ min: "", sec: "" });
  });

  it("joins them back, and treats empty or invalid input as no start time", () => {
    expect(joinStartTime("2", "30")).toBe(150);
    expect(joinStartTime("", "45")).toBe(45);
    expect(joinStartTime("", "")).toBeNull();
    expect(joinStartTime("0", "0")).toBeNull();
    expect(joinStartTime("-1", "10")).toBeNull();
    expect(joinStartTime("abc", "10")).toBeNull();
  });
});

describe("video hints", () => {
  it("recognises YouTube and Vimeo hosts and nothing else", () => {
    expect(looksLikeVideoUrl("https://www.youtube.com/watch?v=abcdefghijk")).toBe(true);
    expect(looksLikeVideoUrl("https://youtu.be/abcdefghijk")).toBe(true);
    expect(looksLikeVideoUrl("https://vimeo.com/123456789")).toBe(true);
    expect(looksLikeVideoUrl("https://example.com/watch")).toBe(false);
    expect(looksLikeVideoUrl("not a url")).toBe(false);
  });

  it("adds autoplay and keeps the start time", () => {
    expect(withAutoplay("https://www.youtube-nocookie.com/embed/abc?start=90")).toBe("https://www.youtube-nocookie.com/embed/abc?start=90&autoplay=1");
    expect(withAutoplay("https://player.vimeo.com/video/1")).toBe("https://player.vimeo.com/video/1?autoplay=1");
  });
});

describe("describeTarget", () => {
  const name = (slug: string) => (slug === "hummus" ? "Hummus" : null);
  it("describes where a link applies", () => {
    expect(describeTarget({ partSlug: null, stepNo: null }, name)).toBeNull();
    expect(describeTarget({ partSlug: null, stepNo: 3 }, name)).toBe("Step 3");
    expect(describeTarget({ partSlug: "hummus", stepNo: null }, name)).toBe("Hummus");
    expect(describeTarget({ partSlug: "hummus", stepNo: 2 }, name)).toBe("Hummus, step 2");
  });
});
