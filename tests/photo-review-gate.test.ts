import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actionDenial } from "../lib/auth/access";
import { getData, getDb } from "../lib/server/context";
import { PHOTO_REVIEW_DISABLED_MESSAGE, photoReviewEnabled } from "../lib/photos/review-flag";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));
vi.mock("../lib/auth/access", () => ({ actionDenial: vi.fn(), requirePageMember: vi.fn(), requireMember: vi.fn() }));
vi.mock("../lib/server/context", () => ({ getDb: vi.fn(), getData: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(actionDenial).mockResolvedValue(null);
});
afterEach(() => vi.unstubAllEnvs());

describe("photoReviewEnabled", () => {
  it.each([
    ["unset outside production", {}, true],
    ["unset in preview", { VERCEL_ENV: "preview" }, true],
    ["unset in development", { VERCEL_ENV: "development" }, true],
    ["unset in production", { VERCEL_ENV: "production" }, false],
    ["blank in production", { VERCEL_ENV: "production", PHOTO_REVIEW_ENABLED: "  " }, false],
    ["true in production", { VERCEL_ENV: "production", PHOTO_REVIEW_ENABLED: "true" }, true],
    ["TRUE with spaces", { PHOTO_REVIEW_ENABLED: " TRUE " }, true],
    ["false outside production", { PHOTO_REVIEW_ENABLED: "false" }, false],
    ["unrecognised value fails closed", { PHOTO_REVIEW_ENABLED: "yes" }, false],
  ])("%s", (_name, env, expected) => {
    expect(photoReviewEnabled(env)).toBe(expected);
  });

  it("reads process.env by default", () => {
    vi.stubEnv("PHOTO_REVIEW_ENABLED", "false");
    expect(photoReviewEnabled()).toBe(false);
  });
});

describe("with review off", () => {
  beforeEach(() => vi.stubEnv("PHOTO_REVIEW_ENABLED", "false"));

  const item = { kind: "recipe" as const, slug: "any-recipe", key: "commons:any" };
  it.each([
    ["listPendingKeys", (a: typeof import("../app/photos/review/actions")) => a.listPendingKeys({})],
    ["approveLibraryBatch", (a: typeof import("../app/photos/review/actions")) => a.approveLibraryBatch({ items: [item] })],
    ["rejectLibraryBatch", (a: typeof import("../app/photos/review/actions")) => a.rejectLibraryBatch({ items: [item] })],
    ["removeLibraryPhoto", (a: typeof import("../app/photos/review/actions")) => a.removeLibraryPhoto("0d4f1b1c-7a6e-4a53-8d0b-2f6f7f5a3c11")],
    ["setLibraryCover", (a: typeof import("../app/photos/review/actions")) => a.setLibraryCover("0d4f1b1c-7a6e-4a53-8d0b-2f6f7f5a3c11")],
    ["undoLibraryRejection", (a: typeof import("../app/photos/review/actions")) => a.undoLibraryRejection(item)],
  ])("%s refuses and touches nothing", async (_name, call) => {
    const actions = await import("../app/photos/review/actions");
    expect(await call(actions)).toEqual({ ok: false, error: PHOTO_REVIEW_DISABLED_MESSAGE });
    expect(getDb).not.toHaveBeenCalled();
    expect(getData).not.toHaveBeenCalled();
  });

  it("the review page returns 404 before loading anything", async () => {
    const { default: ReviewPage } = await import("../app/photos/review/page");
    await expect(ReviewPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getData).not.toHaveBeenCalled();
  });

  it("the sidebar hides Review photos but keeps Photo credits", async () => {
    const { Sidebar } = await import("../components/Sidebar");
    const html = renderToStaticMarkup(createElement(Sidebar, { account: "member", photoReview: false }));
    expect(html).not.toContain("/photos/review");
    expect(html).toContain('href="/credits"');
  });
});

describe("with review on", () => {
  it("the sidebar links to Review photos", async () => {
    const { Sidebar } = await import("../components/Sidebar");
    expect(renderToStaticMarkup(createElement(Sidebar, { account: "member", photoReview: true }))).toContain('href="/photos/review"');
  });
});
