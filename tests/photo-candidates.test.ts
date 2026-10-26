import { describe, expect, it } from "vitest";
import { CandidateFileSchema, dedupeCandidates, licenceOk, needsCredit, parseCommonsPage, parseOpenverseResult } from "../lib/photos/candidates";
import { downloadImage, hostAllowed, recheckLicence } from "../lib/photos/remote";

const commonsPage = (over: Record<string, unknown> = {}, meta: Record<string, string> = {}) => ({
  title: "File:Falafel_bowl.jpg",
  imageinfo: [{
    thumburl: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Falafel_bowl.jpg/1280px-Falafel_bowl.jpg",
    url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Falafel_bowl.jpg",
    width: 4000, height: 3000, descriptionurl: "https://commons.wikimedia.org/wiki/File:Falafel_bowl.jpg", mime: "image/jpeg",
    extmetadata: {
      LicenseShortName: { value: meta.licence ?? "CC BY-SA 4.0" },
      LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0" },
      Artist: { value: meta.artist ?? '<a href="//commons.wikimedia.org/wiki/User:X">Jane &amp; Co</a>' },
    },
    ...over,
  }],
});

describe("licenceOk", () => {
  it("accepts CC0, public domain, CC BY and CC BY-SA, and nothing with NC or ND", () => {
    for (const l of ["CC0", "CC0 1.0", "Public domain", "CC BY 2.0", "CC BY-SA 4.0", "cc-by-sa-3.0"]) expect(licenceOk(l), l).toBe(true);
    for (const l of ["CC BY-NC 4.0", "CC BY-ND 2.0", "CC BY-NC-SA 3.0", "All rights reserved", "", "GFDL"]) expect(licenceOk(l), l).toBe(false);
  });
  it("asks for credit unless the photo is CC0 or public domain", () => {
    expect(needsCredit("CC0 1.0")).toBe(false);
    expect(needsCredit("Public domain")).toBe(false);
    expect(needsCredit("CC BY 4.0")).toBe(true);
  });
});

describe("parseCommonsPage", () => {
  it("builds a candidate with a clean title, plain-text author and licence link", () => {
    const c = parseCommonsPage(commonsPage())!;
    expect(c).toMatchObject({ key: "commons:File:Falafel_bowl.jpg", provider: "commons", title: "Falafel bowl", author: "Jane & Co", licence: "CC BY-SA 4.0", width: 4000, height: 3000 });
    expect(c.image_url).toContain("upload.wikimedia.org");
    expect(c.source_url).toBe("https://commons.wikimedia.org/wiki/File:Falafel_bowl.jpg");
  });
  it("drops non-free licences, small images, non-photo types and rows without metadata", () => {
    expect(parseCommonsPage(commonsPage({}, { licence: "CC BY-NC 2.0" }))).toBeNull();
    expect(parseCommonsPage(commonsPage({ width: 400, height: 300 }))).toBeNull();
    expect(parseCommonsPage(commonsPage({ mime: "image/svg+xml" }))).toBeNull();
    expect(parseCommonsPage({ title: "File:x.jpg" })).toBeNull();
  });
  it("falls back to an unknown author rather than none", () => {
    expect(parseCommonsPage(commonsPage({}, { artist: "" }))!.author).toBe("Unknown author");
  });
});

describe("parseOpenverseResult", () => {
  const result = { id: "5d9dfccb-2f29-415a-9f7f-42c2e619d66d", title: "Falafel y hummus", creator: "BocaDorada", license: "by", license_version: "2.0", license_url: "https://creativecommons.org/licenses/by/2.0/", foreign_landing_url: "https://www.flickr.com/photos/1/2", width: 1024, height: 768 };
  it("maps a CC BY result and fetches through Openverse's own thumbnail", () => {
    expect(parseOpenverseResult(result)).toMatchObject({ key: "openverse:5d9dfccb-2f29-415a-9f7f-42c2e619d66d", licence: "CC BY 2.0", author: "BocaDorada", image_url: "https://api.openverse.org/v1/images/5d9dfccb-2f29-415a-9f7f-42c2e619d66d/thumb/" });
    expect(parseOpenverseResult({ ...result, license: "cc0", license_version: "1.0" })!.licence).toBe("CC0 1.0");
  });
  it("rejects NC and ND licences and results without a landing page or size", () => {
    expect(parseOpenverseResult({ ...result, license: "by-nc" })).toBeNull();
    expect(parseOpenverseResult({ ...result, license: "by-nd" })).toBeNull();
    expect(parseOpenverseResult({ ...result, foreign_landing_url: null })).toBeNull();
    expect(parseOpenverseResult({ ...result, width: null })).toBeNull();
  });
});

describe("candidate list", () => {
  it("dedupes by key and landing page and caps the count", () => {
    const base = parseCommonsPage(commonsPage())!;
    const list = [base, { ...base }, { ...base, key: "commons:File:Other.jpg" }, { ...base, key: "commons:File:Third.jpg", source_url: "https://commons.wikimedia.org/wiki/File:Third.jpg" }];
    expect(dedupeCandidates(list).map((c) => c.key)).toEqual(["commons:File:Falafel_bowl.jpg", "commons:File:Third.jpg"]);
    expect(dedupeCandidates(list, 1)).toHaveLength(1);
  });
  it("the file schema refuses a non-free licence and more than six per subject", () => {
    const c = parseCommonsPage(commonsPage())!;
    expect(CandidateFileSchema.safeParse({ recipes: { r: [c] }, ingredients: {} }).success).toBe(true);
    expect(CandidateFileSchema.safeParse({ recipes: { r: [{ ...c, licence: "CC BY-NC 4.0" }] }, ingredients: {} }).success).toBe(false);
    expect(CandidateFileSchema.safeParse({ recipes: { r: Array.from({ length: 7 }, () => c) }, ingredients: {} }).success).toBe(false);
  });
});

describe("downloadImage", () => {
  const body = (bytes: number[], init: ResponseInit = {}) => new Response(new Uint8Array(bytes), { status: 200, ...init, headers: { "content-type": "image/jpeg", ...(init.headers as Record<string, string> | undefined) } });

  it("only downloads https from allowlisted hosts", () => {
    expect(hostAllowed("https://upload.wikimedia.org/a.jpg")).toBe(true);
    expect(hostAllowed("https://thumb.wikimedia.org/wikipedia/commons/thumb/2/2c/A.jpg/1280px-A.jpg?utm_source=commons.wikimedia.org")).toBe(true);
    expect(hostAllowed("https://api.openverse.org/v1/images/x/thumb/")).toBe(true);
    for (const u of ["http://upload.wikimedia.org/a.jpg", "https://evil.example/a.jpg", "https://upload.wikimedia.org.evil.example/a.jpg", "https://user:pw@upload.wikimedia.org/a.jpg", "file:///etc/passwd", "https://127.0.0.1/a.jpg", "not a url"]) expect(hostAllowed(u), u).toBe(false);
  });

  it("returns the bytes, and refuses a disallowed host without calling fetch", async () => {
    let calls = 0;
    const fake = (async () => { calls++; return body([1, 2, 3]); }) as unknown as typeof fetch;
    expect([...(await downloadImage("https://upload.wikimedia.org/a.jpg", fake))]).toEqual([1, 2, 3]);
    await expect(downloadImage("https://evil.example/a.jpg", fake)).rejects.toThrow(/not on a site/);
    expect(calls).toBe(1);
  });

  it("follows a redirect only to another allowed host", async () => {
    const hops: string[] = [];
    const fake = (async (u: string) => {
      hops.push(u);
      if (u.includes("start")) return new Response(null, { status: 302, headers: { location: "https://upload.wikimedia.org/final.jpg" } });
      return body([9]);
    }) as unknown as typeof fetch;
    expect([...(await downloadImage("https://api.openverse.org/start", fake))]).toEqual([9]);
    const evil = (async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } })) as unknown as typeof fetch;
    await expect(downloadImage("https://api.openverse.org/start", evil)).rejects.toThrow(/not on a site/);
    const loop = (async () => new Response(null, { status: 302, headers: { location: "https://api.openverse.org/start" } })) as unknown as typeof fetch;
    await expect(downloadImage("https://api.openverse.org/start", loop)).rejects.toThrow(/too many/);
  });

  it("refuses an oversized or failing response", async () => {
    const big = (async () => body([1], { headers: { "content-length": String(9 * 1024 * 1024) } })) as unknown as typeof fetch;
    await expect(downloadImage("https://upload.wikimedia.org/a.jpg", big)).rejects.toThrow(/8 MB/);
    const bad = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    await expect(downloadImage("https://upload.wikimedia.org/a.jpg", bad)).rejects.toThrow(/404/);
    const down = (async () => { throw new Error("network"); }) as unknown as typeof fetch;
    await expect(downloadImage("https://upload.wikimedia.org/a.jpg", down)).rejects.toThrow(/did not answer/);
  });
});

describe("recheckLicence", () => {
  const c = parseCommonsPage(commonsPage())!;
  const answer = (licence: string) => (async () => new Response(JSON.stringify({ query: { pages: { "1": { imageinfo: [{ extmetadata: { LicenseShortName: { value: licence } } }] } } } }), { status: 200 })) as unknown as typeof fetch;

  it("passes when the licence is unchanged, and refuses a changed or removed one", async () => {
    expect(await recheckLicence(c, answer("CC BY-SA 4.0"))).toBeNull();
    expect(await recheckLicence(c, answer("CC BY-NC 4.0"))).toMatch(/changed/);
    expect(await recheckLicence(c, answer("CC BY 4.0"))).toMatch(/changed from/);
  });
  it("asks to try again when the provider cannot be reached", async () => {
    expect(await recheckLicence(c, (async () => { throw new Error("x"); }) as unknown as typeof fetch)).toMatch(/Try again/);
  });
});
