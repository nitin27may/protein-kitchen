import { describe, expect, it, vi } from "vitest";
import type { Candidate } from "../lib/photos/candidates";
import { COMMONS_TITLES_PER_CALL, commonsLicenceProblem, commonsLicences, downloadImage, recheckLicence, recheckOpenverse, userAgent } from "../lib/photos/remote";

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  key: "commons:File:A b.jpg", provider: "commons", title: "A", author: "B", licence: "CC BY-SA 4.0", licence_url: null,
  source_url: "https://commons.wikimedia.org/wiki/File:A_b.jpg", image_url: "https://upload.wikimedia.org/a.jpg", width: 1, height: 1, ...over,
});
const image = (init: ResponseInit = {}) => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/webp" }, ...init });

describe("userAgent", () => {
  it("names the app with its public origin, preferring PRODUCTION_ORIGIN", () => {
    expect(userAgent({ PRODUCTION_ORIGIN: "https://kitchen.example.test/some/path", BETTER_AUTH_URL: "https://other.example.test" })).toBe("ProteinKitchen/0.1 (+https://kitchen.example.test; library photo review)");
    expect(userAgent({ BETTER_AUTH_URL: "https://auth.example.test" })).toContain("https://auth.example.test");
  });
  it("ignores an insecure, credentialed or malformed origin and falls back to the plain name", () => {
    for (const env of [{}, { PRODUCTION_ORIGIN: "http://x.example.test" }, { PRODUCTION_ORIGIN: "not a url" }, { PRODUCTION_ORIGIN: "https://u:p@x.example.test" }]) {
      expect(userAgent(env)).toBe("ProteinKitchen/0.1 (personal meal planner)");
    }
    expect(userAgent({ PRODUCTION_ORIGIN: "http://x.example.test", BETTER_AUTH_URL: "https://auth.example.test" })).toContain("auth.example.test");
  });
  it("reads process.env by default", () => {
    vi.stubEnv("PRODUCTION_ORIGIN", "https://env.example.test");
    expect(userAgent()).toContain("env.example.test");
    vi.unstubAllEnvs();
  });
});

describe("downloadImage hardening", () => {
  it("sends the User-Agent and manual redirects, and honours an outer signal", async () => {
    const seen: RequestInit[] = [];
    const ok = (async (_u: string, init: RequestInit) => { seen.push(init); return image(); }) as unknown as typeof fetch;
    await downloadImage("https://upload.wikimedia.org/a.jpg", ok, { userAgent: "UA-test" });
    expect(new Headers(seen[0]!.headers).get("user-agent")).toBe("UA-test");
    expect(seen[0]!.redirect).toBe("manual");
    await downloadImage("https://upload.wikimedia.org/a.jpg", ok);
    expect(new Headers(seen[1]!.headers).get("user-agent")).toContain("ProteinKitchen");
    const controller = new AbortController();
    const hang = ((_u: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("x"))))) as unknown as typeof fetch;
    const pending = downloadImage("https://upload.wikimedia.org/a.jpg", hang, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/did not answer/);
    await expect(downloadImage("https://upload.wikimedia.org/a.jpg", hang, { timeoutMs: 10 })).rejects.toThrow(/did not answer/);
  });
  it("requires an image content type", async () => {
    for (const type of [null, "text/html", "application/octet-stream"]) {
      const bad = (async () => new Response(new Uint8Array([1]), { status: 200, headers: type ? { "content-type": type } : {} })) as unknown as typeof fetch;
      await expect(downloadImage("https://upload.wikimedia.org/a.jpg", bad)).rejects.toThrow(/did not send an image/);
    }
    const upper = (async () => image({ headers: { "content-type": "IMAGE/PNG" } })) as unknown as typeof fetch;
    await expect(downloadImage("https://upload.wikimedia.org/a.jpg", upper)).resolves.toHaveLength(3);
  });
  it("caps the stream at 8 MB without trusting content-length, and reports a broken stream plainly", async () => {
    const chunk = new Uint8Array(3 * 1024 * 1024);
    let pulls = 0;
    const endless = (async () => new Response(new ReadableStream({ pull(c) { pulls++; c.enqueue(chunk); } }), { status: 200, headers: { "content-type": "image/jpeg" } })) as unknown as typeof fetch;
    await expect(downloadImage("https://upload.wikimedia.org/a.jpg", endless)).rejects.toThrow(/8 MB/);
    expect(pulls).toBeLessThan(10);
    const broken = (async () => new Response(new ReadableStream({ pull(c) { c.error(new Error("reset")); } }), { status: 200, headers: { "content-type": "image/jpeg" } })) as unknown as typeof fetch;
    await expect(downloadImage("https://upload.wikimedia.org/a.jpg", broken)).rejects.toThrow(/interrupted/);
  });
  it("reports redirects without a location, an empty body and a missing body", async () => {
    await expect(downloadImage("https://upload.wikimedia.org/a.jpg", (async () => new Response(null, { status: 301 })) as unknown as typeof fetch)).rejects.toThrow(/broken redirect/);
    const noBody = (async () => ({ ok: true, status: 200, headers: new Headers({ "content-type": "image/jpeg" }), body: null })) as unknown as typeof fetch;
    await expect(downloadImage("https://upload.wikimedia.org/a.jpg", noBody)).rejects.toThrow(/no data/);
  });
  it("re-checks each redirect hop and follows an allowed one", async () => {
    const hops: string[] = [];
    const fake = (async (u: string) => { hops.push(u); return u.endsWith("/start") ? new Response(null, { status: 302, headers: { location: "/final.jpg" } }) : image(); }) as unknown as typeof fetch;
    await downloadImage("https://upload.wikimedia.org/start", fake);
    expect(hops).toEqual(["https://upload.wikimedia.org/start", "https://upload.wikimedia.org/final.jpg"]);
  });
});

describe("commonsLicences", () => {
  const answer = (body: unknown, status = 200) => vi.fn((async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch);

  it("asks once for many titles and maps normalised titles back to the requested ones", async () => {
    const fetchImpl = answer({ query: { normalized: [{ from: "File:A_b.jpg", to: "File:A b.jpg" }], pages: {
      "1": { title: "File:A b.jpg", imageinfo: [{ extmetadata: { LicenseShortName: { value: "CC BY-SA 4.0" } } }] },
      "2": { title: "File:C.jpg", imageinfo: [{}] }, "-1": { title: "File:Gone.jpg", missing: "" },
    } } });
    const found = await commonsLicences(["File:A_b.jpg", "File:C.jpg", "File:Gone.jpg", "File:C.jpg"], fetchImpl);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(new URL(String(fetchImpl.mock.calls[0]![0])).searchParams.get("titles")).toBe("File:A_b.jpg|File:C.jpg|File:Gone.jpg");
    expect([...found]).toEqual([["File:A_b.jpg", "CC BY-SA 4.0"], ["File:C.jpg", ""], ["File:Gone.jpg", ""]]);
  });
  it("makes no call for no titles, refuses more than 50, and fails plainly on a bad answer", async () => {
    const never = vi.fn();
    expect((await commonsLicences([], never as unknown as typeof fetch)).size).toBe(0);
    expect(never).not.toHaveBeenCalled();
    await expect(commonsLicences(Array.from({ length: COMMONS_TITLES_PER_CALL + 1 }, (_, i) => `File:${i}.jpg`), never as unknown as typeof fetch)).rejects.toThrow(/Too many/);
    await expect(commonsLicences(["File:A.jpg"], answer({}, 503))).rejects.toThrow(/Try again/);
    expect((await commonsLicences(["File:A.jpg"], answer({}))).get("File:A.jpg")).toBe("");
    expect((await commonsLicences(["File:A.jpg", "File:B.jpg"], answer({ query: { pages: { "1": { imageinfo: [{}] } } } }))).get("File:B.jpg")).toBe("");
  });
  it("one title with an untitled single page still resolves", async () => {
    const found = await commonsLicences(["File:A.jpg"], answer({ query: { pages: { "1": { imageinfo: [{ extmetadata: { LicenseShortName: { value: "CC0 1.0" } } }] } } } }));
    expect(found.get("File:A.jpg")).toBe("CC0 1.0");
  });
});

describe("licence comparison and Openverse", () => {
  it("compares what the list recorded with what the provider says now", () => {
    expect(commonsLicenceProblem(candidate(), "CC BY-SA 4.0")).toBeNull();
    expect(commonsLicenceProblem(candidate(), "CC BY-SA 3.0")).toMatch(/changed from CC BY-SA 4.0 to CC BY-SA 3.0/);
    expect(commonsLicenceProblem(candidate(), "CC BY-NC 4.0")).toMatch(/cannot be used/);
    expect(commonsLicenceProblem(candidate(), undefined)).toMatch(/cannot be used/);
  });
  it("rechecks Openverse per id with the app's User-Agent", async () => {
    const c = candidate({ key: "openverse:a/b", provider: "openverse", licence: "CC0 1.0" });
    const answer = (body: unknown, status = 200) => vi.fn((async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch);
    const ok = answer({ license: "BY-SA" });
    expect(await recheckOpenverse(c, ok, { userAgent: "UA-x" })).toBeNull();
    expect(String(ok.mock.calls[0]![0])).toBe("https://api.openverse.org/v1/images/a%2Fb/");
    expect(new Headers((ok.mock.calls[0]![1] as RequestInit).headers).get("user-agent")).toBe("UA-x");
    expect(await recheckOpenverse(c, answer({ license: "by-nc" }))).toMatch(/cannot be used/);
    expect(await recheckOpenverse(c, answer({}))).toMatch(/cannot be used/);
    expect(await recheckOpenverse(c, answer({}, 500))).toMatch(/Try again/);
    expect(await recheckOpenverse(c, (async () => { throw new Error("x"); }) as unknown as typeof fetch)).toMatch(/Try again/);
  });
  it("recheckLicence routes by provider and reports an unreadable Commons answer", async () => {
    const c = candidate({ key: "openverse:z", provider: "openverse" });
    expect(await recheckLicence(c, (async () => new Response(JSON.stringify({ license: "cc0" }), { status: 200 })) as unknown as typeof fetch)).toBeNull();
    expect(await recheckLicence(candidate(), (async () => new Response("no", { status: 500 })) as unknown as typeof fetch)).toMatch(/Try again/);
  });
});
