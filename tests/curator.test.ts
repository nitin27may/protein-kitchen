import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../lib/db/schema";
import { openDb, type DbHandle } from "./helpers/db";

const calls: string[] = [];
let h: DbHandle;
const flags = { review: true, writes: true };

vi.mock("../lib/auth/access", () => ({ actionDenial: vi.fn(), requireMember: vi.fn() }));
vi.mock("../lib/photos/review-flag", () => ({ photoReviewEnabled: vi.fn(), PHOTO_REVIEW_DISABLED_MESSAGE: "off" }));
vi.mock("../lib/blob/config", () => ({ photoWritesEnabled: vi.fn() }));
vi.mock("../lib/server/context", () => ({ getDb: async () => h.db }));

import { actionDenial, requireMember } from "../lib/auth/access";
import { photoReviewEnabled } from "../lib/photos/review-flag";
import { photoWritesEnabled } from "../lib/blob/config";
import { curatorDenial, isCurator, parseCuratorEmails } from "../lib/auth/curator";

const user = (id: string, email: string, emailVerified: boolean) => ({ id, name: id, email, emailVerified });
const env = (list?: string) => ({ PHOTO_CURATOR_EMAILS: list });

beforeAll(async () => { h = await openDb(); });
afterAll(async () => { await h.close(); });
beforeEach(async () => {
  await h.db.delete(s.authUsers);
  await h.db.insert(s.authUsers).values([
    user("u1", "Curator@Example.test", true), user("u2", "unverified@example.test", false), user("u3", "other@example.test", true),
  ]);
});

describe("parseCuratorEmails", () => {
  it("treats unset and blank as no curators", () => {
    expect(parseCuratorEmails(undefined).size).toBe(0);
    expect(parseCuratorEmails("  ,  ").size).toBe(0);
  });
  it("trims, lower-cases and de-duplicates", () => {
    expect([...parseCuratorEmails(" A@Example.test, b@example.test ,a@EXAMPLE.test ")]).toEqual(["a@example.test", "b@example.test"]);
  });
  it("rejects domains, malformed entries and more than 5 without echoing the value", () => {
    for (const bad of ["@example.test", "nope", "a@b", "a b@example.test", "a@@example.test", "a@example.test,@x.test"]) {
      try { parseCuratorEmails(bad); expect.unreachable(bad); }
      catch (error) { expect(String(error)).not.toContain(bad); expect((error as Error).message).toMatch(/PHOTO_CURATOR_EMAILS/); }
    }
    const six = Array.from({ length: 6 }, (_, i) => `u${i}@example.test`).join(",");
    expect(() => parseCuratorEmails(six)).toThrow(/at most 5/);
    expect(parseCuratorEmails(six.split(",").slice(0, 5).join(",")).size).toBe(5);
  });
});

describe("isCurator", () => {
  it("accepts a verified listed account, case-insensitively", async () => {
    expect(await isCurator({ userId: "u1" }, env("curator@example.test"))).toBe(true);
  });
  it("refuses unverified, unlisted, unknown, unset and malformed", async () => {
    expect(await isCurator({ userId: "u2" }, env("unverified@example.test"))).toBe(false);
    expect(await isCurator({ userId: "u3" }, env("curator@example.test"))).toBe(false);
    expect(await isCurator({ userId: "missing" }, env("curator@example.test"))).toBe(false);
    expect(await isCurator({ userId: "u1" }, env(undefined))).toBe(false);
    expect(await isCurator({ userId: "u1" }, env(" "))).toBe(false);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await isCurator({ userId: "u1" }, env("@example.test"))).toBe(false);
    expect(JSON.stringify(error.mock.calls)).not.toContain("example.test");
    error.mockRestore();
  });
});

describe("curatorDenial order", () => {
  beforeEach(() => {
    calls.length = 0; flags.review = true; flags.writes = true;
    vi.mocked(actionDenial).mockImplementation(async () => { calls.push("member"); return null; });
    vi.mocked(photoReviewEnabled).mockImplementation(() => { calls.push("review"); return flags.review; });
    vi.mocked(photoWritesEnabled).mockImplementation(() => { calls.push("writes"); return flags.writes; });
    vi.mocked(requireMember).mockResolvedValue({ userId: "u1", role: "member", personId: 1 });
    vi.stubEnv("PHOTO_CURATOR_EMAILS", "curator@example.test");
  });

  it("runs member, review, writes, curator and then allows", async () => {
    const curator = vi.spyOn(await import("../lib/auth/curator"), "isCurator");
    expect(await curatorDenial()).toBeNull();
    expect(calls).toEqual(["member", "review", "writes"]);
    curator.mockRestore();
  });
  it("stops at the first failing check", async () => {
    vi.mocked(actionDenial).mockImplementationOnce(async () => { calls.push("member"); return { ok: false as const, error: "Sign in before continuing." }; });
    expect(await curatorDenial()).toEqual({ ok: false, error: "Sign in before continuing." });
    expect(calls).toEqual(["member"]);
    calls.length = 0; flags.review = false;
    expect(await curatorDenial()).toMatchObject({ ok: false });
    expect(calls).toEqual(["member", "review"]);
    calls.length = 0; flags.review = true; flags.writes = false;
    expect(await curatorDenial()).toMatchObject({ ok: false });
    expect(calls).toEqual(["member", "review", "writes"]);
    expect(requireMember).not.toHaveBeenCalled();
  });
  it("denies a member who is not a curator", async () => {
    vi.mocked(requireMember).mockResolvedValue({ userId: "u3", role: "owner", personId: 2 });
    expect(await curatorDenial()).toEqual({ ok: false, error: "Only photo curators can do that." });
  });
});
