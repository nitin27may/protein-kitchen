export type Stage = "candidate" | "live";

export interface SmokeConfig {
  stage: Stage;
  /** Origin that is exercised. */
  origin: string;
  /** Sent only to `origin`, and only in the candidate stage. */
  bypass: string | undefined;
  expectedSha: string;
  /** Generated *.vercel.app origin that must be denied without the bypass (live stage only). */
  deploymentOrigin: string | undefined;
}

export interface CheckResult { name: string; pass: boolean }
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const SHA = /^[0-9a-f]{7,64}$/;
const HTML_PAGES = ["/", "/recipes", "/ingredients", "/recipes/tofu-burrito-bowl", "/ingredients/tofu-extra-firm", "/sign-in"] as const;

export class SmokeConfigError extends Error {}

/** Returns the bare origin of an https URL with no credentials, path, query or fragment, or throws a value-free error. */
export function strictOrigin(input: string | undefined, label: string, vercelApp?: boolean): string {
  if (!input) throw new SmokeConfigError(`${label} is not set.`);
  let url: URL;
  try { url = new URL(input); } catch { throw new SmokeConfigError(`${label} is not a valid URL.`); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) {
    throw new SmokeConfigError(`${label} must be a bare https origin.`);
  }
  if (vercelApp === true && !url.hostname.endsWith(".vercel.app")) throw new SmokeConfigError(`${label} must be a vercel.app origin.`);
  return url.origin;
}

export function parseSmokeArgs(argv: readonly string[], env: Record<string, string | undefined>): SmokeConfig {
  const stages = argv.filter((arg) => arg.startsWith("--stage="));
  const extra = argv.filter((arg) => !arg.startsWith("--stage="));
  if (stages.length !== 1 || extra.length > 0) throw new SmokeConfigError("Usage: --stage=candidate|live");
  const stage = stages[0]!.slice("--stage=".length);
  if (stage !== "candidate" && stage !== "live") throw new SmokeConfigError("Usage: --stage=candidate|live");
  const expectedSha = env.EXPECTED_SHA ?? "";
  if (!SHA.test(expectedSha)) throw new SmokeConfigError("EXPECTED_SHA must be a lower-case commit hash.");
  if (stage === "candidate") {
    if (!env.PRODUCTION_PROTECTION_BYPASS) throw new SmokeConfigError("PRODUCTION_PROTECTION_BYPASS is not set.");
    return {
      stage, expectedSha, bypass: env.PRODUCTION_PROTECTION_BYPASS, deploymentOrigin: undefined,
      origin: strictOrigin(env.DEPLOYMENT_URL, "DEPLOYMENT_URL", true),
    };
  }
  return {
    stage, expectedSha, bypass: undefined,
    origin: strictOrigin(env.PRODUCTION_ORIGIN, "PRODUCTION_ORIGIN"),
    deploymentOrigin: strictOrigin(env.DEPLOYMENT_URL, "DEPLOYMENT_URL", true),
  };
}

/**
 * Fetch wrapper that never follows redirects and attaches the bypass header only when the request origin equals
 * the single allowed origin. A request to any other origin is refused rather than sent.
 */
export function guardedFetch(base: FetchLike, allowedOrigin: string, bypass: string | undefined): FetchLike {
  return (input, init) => {
    const url = new URL(input);
    if (url.origin !== allowedOrigin) throw new SmokeConfigError("Request to an unexpected origin refused.");
    const headers = new Headers(init?.headers);
    if (bypass) headers.set("x-vercel-protection-bypass", bypass);
    return base(url.toString(), { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(20_000) });
  };
}

async function attempt(name: string, run: () => Promise<boolean>): Promise<CheckResult> {
  try { return { name, pass: await run() }; } catch { return { name, pass: false }; }
}

function realH1(html: string): boolean {
  const match = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  return !!match && match[1]!.replace(/<[^>]*>/g, "").trim().length > 0;
}

function hardened(res: Response): boolean {
  const cache = (res.headers.get("cache-control") ?? "").toLowerCase();
  return cache.includes("private") && cache.includes("no-store") &&
    res.headers.get("x-frame-options")?.toUpperCase() === "DENY" &&
    res.headers.get("x-content-type-options")?.toLowerCase() === "nosniff";
}

export async function runSmoke(config: SmokeConfig, base: FetchLike): Promise<CheckResult[]> {
  const get = guardedFetch(base, config.origin, config.bypass);
  const results: CheckResult[] = [];
  const at = (path: string) => new URL(path, config.origin).toString();

  if (config.stage === "live" && config.deploymentOrigin) {
    const denied = guardedFetch(base, config.deploymentOrigin, undefined);
    results.push(await attempt("deployment URL denied without bypass", async () => {
      const res = await denied(new URL("/", config.deploymentOrigin).toString());
      if (res.status === 401 || res.status === 403) return true;
      const location = res.headers.get("location");
      return res.status >= 300 && res.status < 400 && !!location && new URL(location, config.deploymentOrigin).origin !== config.deploymentOrigin;
    }));
  }

  for (const path of HTML_PAGES) {
    results.push(await attempt(`GET ${path} renders with h1 and hardened headers`, async () => {
      const res = await get(at(path));
      return res.status === 200 && (res.headers.get("content-type") ?? "").includes("text/html") && realH1(await res.text()) && hardened(res);
    }));
  }

  results.push(await attempt("GET /account redirects to /sign-in", async () => {
    const res = await get(at("/account"));
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) return false;
    const target = new URL(location, config.origin);
    return target.origin === config.origin && target.pathname === "/sign-in";
  }));

  results.push(await attempt("GET /api/health is exact and matches expected release", async () => {
    const res = await get(at("/api/health"));
    if (res.status !== 200 || !(res.headers.get("cache-control") ?? "").includes("no-store")) return false;
    const body = await res.json() as Record<string, unknown>;
    return Object.keys(body).sort().join() === "database,library,ok,release" &&
      body.ok === true && body.database === "ok" && body.library === "exact" && body.release === config.expectedSha;
  }));

  results.push(await attempt("POST with foreign Origin is rejected with 403", async () => {
    const res = await get(at("/api/auth/email-otp/send-verification-otp"), {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://foreign.invalid" },
      body: JSON.stringify({ email: "smoke@example.invalid", type: "email-verification" }),
    });
    return res.status === 403;
  }));

  return results;
}

export function formatResults(results: readonly CheckResult[]): { lines: string[]; exitCode: number } {
  const lines = results.map((r) => `${r.pass ? "PASS" : "FAIL"} ${r.name}`);
  const failed = results.filter((r) => !r.pass).length;
  lines.push(failed === 0 ? `PASS all ${results.length} checks` : `FAIL ${failed} of ${results.length} checks`);
  return { lines, exitCode: failed === 0 && results.length > 0 ? 0 : 1 };
}
