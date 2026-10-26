import { execFileSync } from "node:child_process";

type Environment = Readonly<Record<string, string | undefined>>;

/** `gh api <path> [--paginate --slurp]` returning stdout. Injected so tests replay recorded `gh` JSON. */
export type GhApi = (path: string, paginate?: boolean) => string;

export class GateError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "GateError";
  }
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;

export function ghFromCli(env: Environment): GhApi {
  return (path, paginate = false) => {
    try {
      return execFileSync("gh", ["api", ...(paginate ? ["--paginate", "--slurp"] : []), path], {
        env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
      });
    } catch {
      // gh's stderr can echo request details; none of it is copied.
      throw new GateError("GATE_API_FAILED", "A GitHub API request failed.");
    }
  };
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new GateError("GATE_API_INVALID", "GitHub returned a response that is not JSON."); }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export interface CiRun { id: number; head_sha: string; head_branch: string | null; event: string; conclusion: string | null; path?: string }

function runsOf(json: unknown): CiRun[] {
  if (!isRecord(json) || !Array.isArray(json.workflow_runs)) throw new GateError("GATE_API_INVALID", "The workflow run listing has an unexpected shape.");
  return json.workflow_runs.filter((run): run is CiRun => isRecord(run) && typeof run.id === "number" && typeof run.head_sha === "string" &&
    typeof run.event === "string");
}

/** `gh api --paginate --slurp` returns an array of pages; a single page object is accepted as well. */
export function jobsOf(json: unknown): { name: string; conclusion: string | null }[] {
  const pages = Array.isArray(json) ? json : [json];
  const jobs: { name: string; conclusion: string | null }[] = [];
  for (const page of pages) {
    if (!isRecord(page) || !Array.isArray(page.jobs)) throw new GateError("GATE_API_INVALID", "The job listing has an unexpected shape.");
    for (const job of page.jobs) {
      if (isRecord(job) && typeof job.name === "string") jobs.push({ name: job.name, conclusion: typeof job.conclusion === "string" ? job.conclusion : null });
    }
  }
  return jobs;
}

export interface AcceptanceInput { repository: string; sha: string; branch?: string }

/** Requires a successful push-event `ci.yml` run for the exact SHA whose `acceptance` job succeeded. Fails closed. */
export function requireAcceptance(gh: GhApi, { repository, sha, branch }: AcceptanceInput): void {
  if (!REPOSITORY.test(repository) || !FULL_SHA.test(sha)) throw new GateError("GATE_CONFIG", "The repository or commit is malformed.");
  const listing = parseJson(gh(`repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&status=success&per_page=100`));
  const run = runsOf(listing).find((r) => r.head_sha === sha && r.event === "push" && r.conclusion === "success" &&
    (branch === undefined || r.head_branch === branch));
  if (!run) throw new GateError("GATE_NO_CI", "A successful push CI run for this exact commit is required.");
  const jobs = jobsOf(parseJson(gh(`repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`, true)));
  const acceptance = jobs.filter((job) => job.name === "acceptance");
  if (acceptance.length === 0 || !acceptance.every((job) => job.conclusion === "success")) {
    throw new GateError("GATE_NO_ACCEPTANCE", "The acceptance job did not succeed for this commit.");
  }
}

export interface GateResult { sha: string }

function shaOf(json: unknown): string {
  return isRecord(json) && typeof json.sha === "string" ? json.sha : "";
}

/** Production gate: which SHA, whether CI let it through, and whether it is still the tip of main. */
export function productionGate(env: Environment, gh: GhApi): GateResult {
  const repository = env.REPOSITORY ?? "";
  let sha: string;
  if (env.EVENT_NAME === "workflow_run") {
    if (env.RUN_CONCLUSION !== "success") throw new GateError("GATE_REFUSED", "The triggering CI run did not succeed.");
    if (env.RUN_EVENT !== "push") throw new GateError("GATE_REFUSED", "Only a CI run caused by a push can release.");
    if (env.RUN_HEAD_BRANCH !== "main") throw new GateError("GATE_REFUSED", "Only a CI run on main can release.");
    sha = env.RUN_HEAD_SHA ?? "";
  } else if (env.EVENT_NAME === "workflow_dispatch") {
    if (env.GITHUB_REF !== "refs/heads/main") throw new GateError("GATE_REFUSED", "A manual release must be started from main.");
    sha = env.GITHUB_SHA ?? "";
  } else {
    throw new GateError("GATE_REFUSED", "This event cannot release.");
  }
  if (!FULL_SHA.test(sha) || !REPOSITORY.test(repository)) throw new GateError("GATE_CONFIG", "The commit or repository is malformed.");
  if (shaOf(parseJson(gh(`repos/${repository}/commits/main`))) !== sha) {
    throw new GateError("GATE_SUPERSEDED", "superseded: main has moved on since this commit; a newer run owns the release.");
  }
  requireAcceptance(gh, { repository, sha, branch: "main" });
  return { sha };
}

/**
 * Rehearsal gate: only the tip of main, started by hand from main, with the same accepted CI as a release. Unmerged
 * branches are never rehearsed because the job runs their code with NEON_API_KEY in scope.
 */
export function rehearsalGate(env: Environment, gh: GhApi): GateResult {
  if (env.EVENT_NAME !== "workflow_dispatch") throw new GateError("GATE_REFUSED", "A rehearsal can only be started by hand.");
  return productionGate(env, gh);
}
