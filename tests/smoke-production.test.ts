import { describe, expect, it } from "vitest";
import {
  SmokeConfigError, formatResults, guardedFetch, parseSmokeArgs, runSmoke, strictOrigin,
  type FetchLike, type SmokeConfig,
} from "../lib/smoke/production";

const SHA = "b".repeat(40);
const CAND = "https://app-abc123-team.vercel.app";
const PROD = "https://meals.example.com";
const base = { EXPECTED_SHA: SHA };

describe("argument and origin rules", () => {
  it("parses the candidate stage", () => {
    expect(parseSmokeArgs(["--stage=candidate"], { ...base, DEPLOYMENT_URL: `${CAND}/`, PRODUCTION_PROTECTION_BYPASS: "s" }))
      .toEqual({ stage: "candidate", origin: CAND, bypass: "s", expectedSha: SHA, deploymentOrigin: undefined });
  });
  it("parses the live stage without a bypass, even if one is in the environment", () => {
    const c = parseSmokeArgs(["--stage=live"], { ...base, PRODUCTION_ORIGIN: PROD, DEPLOYMENT_URL: CAND, PRODUCTION_PROTECTION_BYPASS: "s" });
    expect(c).toEqual({ stage: "live", origin: PROD, bypass: undefined, expectedSha: SHA, deploymentOrigin: CAND });
  });
  it("rejects bad arguments and environment", () => {
    const ok = { ...base, DEPLOYMENT_URL: CAND, PRODUCTION_PROTECTION_BYPASS: "s", PRODUCTION_ORIGIN: PROD };
    for (const argv of [[], ["--stage=other"], ["--stage=live", "--stage=candidate"], ["--stage=live", "extra"]]) {
      expect(() => parseSmokeArgs(argv, ok)).toThrow(SmokeConfigError);
    }
    expect(() => parseSmokeArgs(["--stage=live"], { ...ok, EXPECTED_SHA: "ABC" })).toThrow("EXPECTED_SHA");
    expect(() => parseSmokeArgs(["--stage=live"], { ...ok, EXPECTED_SHA: undefined })).toThrow("EXPECTED_SHA");
    expect(() => parseSmokeArgs(["--stage=candidate"], { ...ok, PRODUCTION_PROTECTION_BYPASS: "" })).toThrow("BYPASS");
    expect(() => parseSmokeArgs(["--stage=candidate"], { ...ok, DEPLOYMENT_URL: PROD })).toThrow("vercel.app");
    expect(() => parseSmokeArgs(["--stage=live"], { ...ok, DEPLOYMENT_URL: undefined })).toThrow("not set");
  });
  it("accepts only bare https origins", () => {
    expect(strictOrigin(`${PROD}/`, "X")).toBe(PROD);
    for (const bad of [undefined, "", "not a url", "http://a.com", "https://u:p@a.com", "https://a.com/x", "https://a.com/?q=1", "https://a.com/#h", "https://a.com:8443"]) {
      expect(() => strictOrigin(bad, "X")).toThrow(SmokeConfigError);
    }
  });
  it("errors never contain the supplied value", () => {
    try { strictOrigin("https://user:topsecret@a.com/path", "X"); } catch (e) { expect(String(e)).not.toContain("topsecret"); }
  });
});

describe("guardedFetch", () => {
  it("sends the bypass only to the allowed origin and refuses any other", async () => {
    const seen: { url: string; headers: Headers; redirect?: string }[] = [];
    const fake: FetchLike = async (url, init) => { seen.push({ url, headers: new Headers(init?.headers), redirect: init?.redirect }); return new Response("x"); };
    const f = guardedFetch(fake, CAND, "tok");
    await f(`${CAND}/recipes`);
    expect(seen[0]!.headers.get("x-vercel-protection-bypass")).toBe("tok");
    expect(seen[0]!.redirect).toBe("manual");
    expect(() => f("https://other.example.com/")).toThrow(SmokeConfigError);
    expect(() => f(`${CAND}.evil.com/`)).toThrow(SmokeConfigError);
    expect(seen).toHaveLength(1);
    await guardedFetch(fake, PROD, undefined)(`${PROD}/`);
    expect(seen[1]!.headers.has("x-vercel-protection-bypass")).toBe(false);
  });
});

const html = (h1 = "Recipes") => `<html><body><h1 class="x">${h1}</h1></body></html>`;
const goodHeaders = { "content-type": "text/html", "cache-control": "private, no-store", "x-frame-options": "DENY", "x-content-type-options": "nosniff" };
type Handler = (url: URL, init?: RequestInit) => Response | undefined;
function site(override: Handler = () => undefined, calls: { url: string; headers: Headers; method: string }[] = []): FetchLike {
  return async (input, init) => {
    const url = new URL(input);
    calls.push({ url: input, headers: new Headers(init?.headers), method: init?.method ?? "GET" });
    const o = override(url, init);
    if (o) return o;
    if (url.pathname === "/account") return new Response(null, { status: 307, headers: { location: "/sign-in" } });
    if (url.pathname === "/api/health") return Response.json({ ok: true, release: SHA, database: "ok", library: "exact" }, { headers: { "cache-control": "no-store" } });
    if (url.pathname === "/api/auth/email-otp/send-verification-otp") return new Response("{}", { status: 403 });
    return new Response(html(), { status: 200, headers: goodHeaders });
  };
}
const candidate: SmokeConfig = { stage: "candidate", origin: CAND, bypass: "tok", expectedSha: SHA, deploymentOrigin: undefined };
const live: SmokeConfig = { stage: "live", origin: PROD, bypass: undefined, expectedSha: SHA, deploymentOrigin: CAND };
const denyDeployment: Handler = (url) => url.origin === CAND ? new Response("no", { status: 401 }) : undefined;

describe("runSmoke", () => {
  it("passes a healthy candidate, writing nothing and sending the bypass only to the candidate", async () => {
    const calls: { url: string; headers: Headers; method: string }[] = [];
    const results = await runSmoke(candidate, site(undefined, calls));
    expect(results.every((r) => r.pass)).toBe(true);
    expect(formatResults(results).exitCode).toBe(0);
    expect(calls.every((c) => new URL(c.url).origin === CAND && c.headers.get("x-vercel-protection-bypass") === "tok")).toBe(true);
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(1);
  });
  it("passes a healthy live stage with no bypass header anywhere", async () => {
    const calls: { url: string; headers: Headers; method: string }[] = [];
    const results = await runSmoke(live, site(denyDeployment, calls));
    expect(results.every((r) => r.pass)).toBe(true);
    expect(calls.some((c) => c.headers.has("x-vercel-protection-bypass"))).toBe(false);
    expect(calls.some((c) => new URL(c.url).origin === CAND)).toBe(true);
  });
  it("output lines carry no host, header or body values", async () => {
    const { lines } = formatResults(await runSmoke(live, site(denyDeployment)));
    expect(lines.join("\n")).not.toMatch(/https?:|vercel\.app|example\.com|tok|bbbb/);
  });

  const failing: [string, Handler][] = [
    ["page 500", (u) => u.pathname === "/recipes" ? new Response("x", { status: 500 }) : undefined],
    ["page without h1", (u) => u.pathname === "/" ? new Response("<p>hi</p>", { status: 200, headers: goodHeaders }) : undefined],
    ["empty h1", (u) => u.pathname === "/" ? new Response(html("  "), { status: 200, headers: goodHeaders }) : undefined],
    ["page without headers", (u) => u.pathname === "/" ? new Response(html(), { status: 200, headers: { "content-type": "text/html" } }) : undefined],
    ["page without content type", (u) => u.pathname === "/" ? new Response(null, { status: 200, headers: { "cache-control": "private, no-store", "x-frame-options": "DENY", "x-content-type-options": "nosniff" } }) : undefined],
    ["non-html page", (u) => u.pathname === "/sign-in" ? new Response(html(), { status: 200, headers: { ...goodHeaders, "content-type": "text/plain" } }) : undefined],
    ["cacheable html", (u) => u.pathname === "/" ? new Response(html(), { headers: { ...goodHeaders, "cache-control": "public, max-age=60" } }) : undefined],
    ["missing frame header", (u) => u.pathname === "/" ? new Response(html(), { headers: { ...goodHeaders, "x-frame-options": "SAMEORIGIN" } }) : undefined],
    ["missing nosniff", (u) => u.pathname === "/" ? new Response(html(), { headers: { ...goodHeaders, "x-content-type-options": "" } }) : undefined],
    ["account not redirected", (u) => u.pathname === "/account" ? new Response(html(), { status: 200, headers: goodHeaders }) : undefined],
    ["account redirect without location", (u) => u.pathname === "/account" ? new Response(null, { status: 307 }) : undefined],
    ["account redirect elsewhere", (u) => u.pathname === "/account" ? new Response(null, { status: 307, headers: { location: "/recipes" } }) : undefined],
    ["account redirect off origin", (u) => u.pathname === "/account" ? new Response(null, { status: 307, headers: { location: "https://x.example/sign-in" } }) : undefined],
    ["health 503", (u) => u.pathname === "/api/health" ? Response.json({ ok: false }, { status: 503, headers: { "cache-control": "no-store" } }) : undefined],
    ["health cacheable", (u) => u.pathname === "/api/health" ? Response.json({ ok: true, release: SHA, database: "ok", library: "exact" }) : undefined],
    ["health wrong sha", (u) => u.pathname === "/api/health" ? Response.json({ ok: true, release: "c".repeat(40), database: "ok", library: "exact" }, { headers: { "cache-control": "no-store" } }) : undefined],
    ["health compatible only", (u) => u.pathname === "/api/health" ? Response.json({ ok: true, release: SHA, database: "ok", library: "compatible" }, { headers: { "cache-control": "no-store" } }) : undefined],
    ["health extra field", (u) => u.pathname === "/api/health" ? Response.json({ ok: true, release: SHA, database: "ok", library: "exact", host: "h" }, { headers: { "cache-control": "no-store" } }) : undefined],
    ["health not json", (u) => u.pathname === "/api/health" ? new Response("oops", { status: 200, headers: { "cache-control": "no-store" } }) : undefined],
    ["foreign origin accepted", (u) => u.pathname.startsWith("/api/auth") ? new Response("{}", { status: 200 }) : undefined],
  ];
  for (const [label, handler] of failing) {
    it(`fails and exits non-zero on: ${label}`, async () => {
      const results = await runSmoke(candidate, site(handler));
      expect(results.some((r) => !r.pass)).toBe(true);
      const out = formatResults(results);
      expect(out.exitCode).toBe(1);
      expect(out.lines.some((l) => l.startsWith("FAIL"))).toBe(true);
    });
  }
  it("fails when the network throws", async () => {
    const results = await runSmoke(candidate, async () => { throw new Error("https://secret.host leaked"); });
    expect(results.every((r) => !r.pass)).toBe(true);
    expect(formatResults(results).lines.join("")).not.toContain("secret");
  });

  const deploymentCases: [string, Handler, boolean][] = [
    ["open deployment URL", (u) => u.origin === CAND ? new Response(html(), { status: 200 }) : undefined, false],
    ["redirect to a login host", (u) => u.origin === CAND ? new Response(null, { status: 307, headers: { location: "https://vercel.com/sso" } }) : undefined, true],
    ["403", (u) => u.origin === CAND ? new Response("", { status: 403 }) : undefined, true],
    ["redirect to itself", (u) => u.origin === CAND ? new Response(null, { status: 307, headers: { location: "/x" } }) : undefined, false],
    ["redirect with no location", (u) => u.origin === CAND ? new Response(null, { status: 307 }) : undefined, false],
    ["500", (u) => u.origin === CAND ? new Response("", { status: 500 }) : undefined, false],
  ];
  for (const [label, handler, denied] of deploymentCases) {
    it(`live stage deployment-denial check: ${label}`, async () => {
      const results = await runSmoke(live, site(handler));
      expect(results[0]!.name).toContain("denied");
      expect(results[0]!.pass).toBe(denied);
      expect(formatResults(results).exitCode).toBe(denied ? 0 : 1);
    });
  }
  it("an empty result set is a failure", () => {
    expect(formatResults([]).exitCode).toBe(1);
  });
});
