import { readFileSync } from "node:fs";
import vm from "node:vm";
// @ts-expect-error Next ships its compiled path-to-regexp without types; this is the matcher next.config sources use.
import { pathToRegexp } from "next/dist/compiled/path-to-regexp";
import { describe, expect, it } from "vitest";
import config from "../next.config";

/** Runs public/sw.js against a fake service-worker scope and reports whether it takes over a GET of the path. */
function swHandles(pathname: string, method = "GET"): boolean {
  const listeners: Record<string, (event: unknown) => void> = {};
  const self = { location: { origin: "https://pk.test" }, addEventListener: (type: string, fn: (event: unknown) => void) => { listeners[type] = fn; }, skipWaiting: () => undefined };
  vm.runInNewContext(readFileSync("public/sw.js", "utf8"), { self, URL, caches: {}, fetch: () => Promise.resolve({ ok: false }), Response: { error: () => undefined } });
  let handled = false;
  listeners.fetch!({ request: { method, url: `https://pk.test${pathname}` }, respondWith: () => { handled = true; } });
  return handled;
}

describe("service worker", () => {
  it("handles only static assets and never a household or library photo", () => {
    expect(swHandles("/_next/static/chunk.js")).toBe(true);
    expect(swHandles("/icon.svg")).toBe(true);
    for (const path of ["/photos/abc/master", "/photos/abc/thumb", "/library-photos/abc/master", "/library-photos/abc/thumb", "/recipes", "/api/anon-library"]) expect(swHandles(path), path).toBe(false);
    expect(swHandles("/_next/static/chunk.js", "POST")).toBe(false);
  });
});

describe("next.config headers", () => {
  it("keeps everything private by default except the library photo route, which gets only the security headers", async () => {
    const entries = await config.headers!();
    const matches = (source: string, path: string) => pathToRegexp(source).test(path);
    const forPath = (path: string) => entries.filter((e) => matches(e.source, path)).flatMap((e) => e.headers.map((x) => `${x.key}: ${x.value}`));
    for (const path of ["/", "/recipes", "/photos/abc/master", "/api/health"]) {
      expect(forPath(path), path).toContain("Cache-Control: private, no-store");
    }
    for (const path of ["/library-photos/abc/master", "/library-photos/abc/thumb"]) {
      const headers = forPath(path);
      expect(headers.some((h) => h.startsWith("Cache-Control")), path).toBe(false);
      expect(headers).toEqual(expect.arrayContaining(["X-Content-Type-Options: nosniff", "X-Frame-Options: DENY", "Referrer-Policy: same-origin"]));
    }
  });
});
