import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { allSteps, expectOrderedCommands, indexOfCommand, loadWorkflow } from "./helpers/workflow-contract";
import { ghFromCli, GateError, jobsOf, productionGate, rehearsalGate, requireAcceptance } from "../lib/deployment/release-gate";
import type { GhApi } from "../lib/deployment/release-gate";

const { text, workflow } = loadWorkflow("production.yml");
const gate = workflow.jobs.gate!;
const release = workflow.jobs.release!;
const sha = "0123456789abcdef0123456789abcdef01234567";
const other = "fedcba9876543210fedcba9876543210fedcba98";

describe("production workflow contract", () => {
  it("runs after ci on main or by hand, with read-only default permissions", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["workflow_dispatch", "workflow_run"]);
    expect(workflow.on.workflow_run).toEqual({ workflows: ["ci"], types: ["completed"], branches: ["main"] });
    expect(workflow.on.workflow_dispatch).toBeNull();
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(text).not.toContain("pull_request");
  });

  it("keeps the gate free of environment and secrets with minimal permissions", () => {
    expect(gate.environment).toBeUndefined();
    expect(JSON.stringify(gate)).not.toMatch(/secrets\./);
    expect(JSON.stringify(gate)).not.toContain("vars.");
    expect(gate.permissions).toEqual({ contents: "read", actions: "read" });
    expect(gate["timeout-minutes"]).toBe(5);
    expect(gate.outputs).toEqual({ sha: "${{ steps.gate.outputs.sha }}" });
    expect(gate.steps.at(-1)!.run).toBe("pnpm deploy:gate production");
  });

  it("skips the gate quietly unless ci succeeded or the run is manual", () => {
    expect(gate.if).toBe("${{ github.event.workflow_run.conclusion == 'success' || github.event_name == 'workflow_dispatch' }}");
  });

  it("releases in the production environment, one at a time, without cancelling", () => {
    expect(release.needs).toBe("gate");
    expect(release.environment).toBe("production");
    expect(release.concurrency).toEqual({ group: "production", "cancel-in-progress": false });
    expect(release["timeout-minutes"]).toBe(30);
    expect(release.env).toMatchObject({
      DEPLOYMENT_ENVIRONMENT: "production", DATABASE_ENV: "production", APP_RELEASE_SHA: "${{ needs.gate.outputs.sha }}",
    });
    const checkout = release.steps.find((step) => step.uses?.startsWith("actions/checkout"))!;
    expect(checkout.with).toMatchObject({ ref: "${{ needs.gate.outputs.sha }}", "persist-credentials": false });
  });

  it("hands the release job variables by name and each secret only to the steps that need it", () => {
    const secrets = ["VERCEL_TOKEN", "DATABASE_URL", "DATABASE_URL_UNPOOLED", "NEON_API_KEY", "PRODUCTION_PROTECTION_BYPASS"];
    const vars = [
      "VERCEL_ORG_ID", "VERCEL_PROJECT_ID", "NEON_PROJECT_ID", "NEON_PRODUCTION_BRANCH_ID", "DATABASE_PRODUCTION_HOST",
      "DATABASE_DIRECT_PRODUCTION_HOST", "PRODUCTION_ORIGIN", "AUTH_EMAIL_FROM", "SNAPSHOT_RETENTION_DAYS",
    ];
    for (const name of vars) expect(release.env![name]).toBe(`\${{ vars.${name} }}`);
    for (const name of secrets) expect(release.env).not.toHaveProperty(name);
    expect(JSON.stringify(release.env)).not.toContain("secrets.");
    expect([...new Set([...text.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]))].sort()).toEqual([...secrets].sort());
    for (const step of release.steps) {
      for (const [key, value] of Object.entries(step.env ?? {})) {
        if (value.includes("secrets.")) expect(value).toBe(`\${{ secrets.${key} }}`);
      }
    }
    expect(text).not.toMatch(/secrets:\s*inherit/);
    expect(text).not.toMatch(/^\s*secrets:/m);
  });

  it("keeps database and Neon credentials away from install, Vercel pull, build, deploy and promote", () => {
    const sees = (step: (typeof release.steps)[number], key: string) => Boolean(step.env?.[key]);
    const noDb = (step: (typeof release.steps)[number]) => {
      for (const key of ["DATABASE_URL", "DATABASE_URL_UNPOOLED", "NEON_API_KEY", "PRODUCTION_PROTECTION_BYPASS"]) expect(sees(step, key), `${step.name} ${key}`).toBe(false);
    };
    for (const step of release.steps.filter((s) => s.uses || s.run === "pnpm install --frozen-lockfile" || (s.run ?? "").startsWith("npm install --global"))) {
      expect(step.env).toBeUndefined();
    }
    for (const needle of ["vercel pull", "vercel build", "vercel deploy", "vercel promote", "deploy:manifest", "deploy:release"]) {
      for (const step of release.steps.filter((s) => (s.run ?? "").includes(needle))) { noDb(step); expect(sees(step, "VERCEL_TOKEN")).toBe(true); }
    }
    for (const needle of ["db:check:production", "db:snapshot:production", "db:migrate:postgres", "pnpm seed"]) {
      for (const step of release.steps.filter((s) => (s.run ?? "").includes(needle))) {
        expect(step.env).toMatchObject({ DATABASE_URL: "${{ secrets.DATABASE_URL }}", DATABASE_URL_UNPOOLED: "${{ secrets.DATABASE_URL_UNPOOLED }}", NEON_API_KEY: "${{ secrets.NEON_API_KEY }}" });
        expect(sees(step, "VERCEL_TOKEN")).toBe(false);
      }
    }
  });

  it("runs the steps in the required order", () => {
    const order = expectOrderedCommands(release.steps, [
      "pnpm deploy:manifest", "pnpm deploy:assert-protection",
      "db:check:production --phase=pre-migrate --runtime-manifest=", "pnpm db:snapshot:production", "pnpm db:migrate:postgres",
      "pnpm seed", "db:check:production --phase=pre-deploy --runtime-manifest=", "pnpm deploy:release previous",
      "vercel pull --yes --environment=production", "vercel build --prod", "vercel deploy --prebuilt --prod --skip-domain --json",
      "pnpm deploy:release candidate", "--stage=candidate", "vercel promote", "pnpm deploy:release wait-alias", "--stage=live",
    ]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const names = release.steps.map((step) => step.name ?? step.uses ?? step.run);
    expect(names.slice(0, 2).join()).toContain("actions/checkout");
    const setup = release.steps.findIndex((s) => s.run === "pnpm install --frozen-lockfile");
    expect(setup).toBeGreaterThan(1);
    expect(indexOfCommand(release.steps, "npm install --global vercel@")).toBeGreaterThan(setup);
    expect(indexOfCommand(release.steps, "pnpm deploy:manifest")).toBeGreaterThan(indexOfCommand(release.steps, "Missing release settings"));
  });

  it("pulls Vercel settings only after every database step and never sources them", () => {
    const pull = indexOfCommand(release.steps, "vercel pull");
    for (const needle of ["db:check:production", "db:snapshot:production", "db:migrate:postgres", "pnpm seed"]) {
      const last = release.steps.reduce((acc, step, i) => ((step.run ?? "").includes(needle) ? i : acc), -1);
      expect(last).toBeGreaterThanOrEqual(0);
      expect(last).toBeLessThan(pull);
    }
    expect(release.steps.filter((s) => (s.run ?? "").includes("vercel pull"))).toHaveLength(1);
    expect(text).not.toMatch(/\bsource\b|\. \.vercel|export \$\(|\.vercel\/\.env[^\s]*\s*\|\s*/);
    expect(text).not.toMatch(/cat \.vercel/);
  });

  it("skips-domain on deploy and checks the candidate before and after promote", () => {
    const deploy = release.steps.find((s) => (s.run ?? "").includes("vercel deploy"))!;
    expect(deploy.run).toContain("--skip-domain");
    expect(deploy.run).toContain("--prebuilt");
    const smoke = release.steps.filter((s) => (s.run ?? "").includes("deploy:smoke:production"));
    expect(smoke).toHaveLength(2);
    expect(smoke[0]!.env).toMatchObject({ DEPLOYMENT_URL: "${{ steps.candidate.outputs.url }}", EXPECTED_SHA: "${{ needs.gate.outputs.sha }}" });
    expect(smoke[1]!.env).toMatchObject({ DEPLOYMENT_URL: "${{ steps.candidate.outputs.url }}", EXPECTED_SHA: "${{ needs.gate.outputs.sha }}" });
  });

  it("pins every action to a full SHA, the Vercel CLI to an exact version, and drops checkout credentials", () => {
    const uses = allSteps(workflow).flatMap((step) => (step.uses ? [step.uses] : []));
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) expect(action).toMatch(/^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
    const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const approved = new Set([...ci.matchAll(/uses: (\S+@[a-f0-9]{40})/g)].map((m) => m[1]));
    for (const action of uses) expect(approved.has(action)).toBe(true);
    const installs = [...text.matchAll(/npm (?:install|i)\b[^\n]*vercel[^\n]*/g)].map((m) => m[0]);
    expect(installs).toHaveLength(1);
    expect(installs[0]).toMatch(/--global vercel@\d+\.\d+\.\d+$/);
    expect(text).not.toMatch(/vercel@(latest|next|canary)|npx vercel|pnpm dlx vercel/);
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps.filter((s) => s.uses?.startsWith("actions/checkout"))) {
        expect(step.with?.["persist-credentials"]).toBe(false);
      }
    }
  });

  it("always cleans up pulled settings, build output and the manifest, and uploads no artifact", () => {
    const last = release.steps.at(-1)!;
    expect(last.if).toBe("${{ always() }}");
    expect(last.run).toContain("rm -f .vercel/.env*");
    expect(last.run).toContain("rm -rf .vercel/output");
    expect(last.run).toContain("manifest.json");
    expect(text).not.toContain("upload-artifact");
    expect(text).not.toContain("actions/cache");
  });

  it("never echoes or prints credentials", () => {
    expect(text).not.toMatch(/\becho\b[^\n]*\$\{?(VERCEL_TOKEN|DATABASE_URL|NEON_API_KEY|PRODUCTION_PROTECTION_BYPASS)/);
    expect(text).not.toMatch(/\b(env|printenv|set -x)\b\s*$/m);
    expect(text).not.toMatch(/ACTIONS_STEP_DEBUG/);
    expect(text).not.toContain("pull_request_target");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Gate logic against recorded `gh api` shapes
// ---------------------------------------------------------------------------------------------------------------

const run = (over: Record<string, unknown> = {}) => ({
  id: 9001, name: "ci", head_branch: "main", head_sha: sha, path: ".github/workflows/ci.yml", event: "push",
  status: "completed", conclusion: "success", workflow_id: 77, run_number: 41, actor: { login: "someone" }, ...over,
});
const runs = (...items: unknown[]) => JSON.stringify({ total_count: items.length, workflow_runs: items });
const job = (name: string, conclusion: string | null) => ({ id: 1, name, status: "completed", conclusion, steps: [] });
const jobsPage = (...items: unknown[]) => ({ total_count: items.length, jobs: items });
const goodJobs = JSON.stringify([jobsPage(job("ci", "success"), job("browser", "success")), jobsPage(job("secrets", "success"), job("acceptance", "success"))]);

interface Routes { head?: string; runs?: string; jobs?: string; ref?: string }
function fakeGh(routes: Routes): { gh: GhApi; calls: string[] } {
  const calls: string[] = [];
  const gh: GhApi = (apiPath, paginate) => {
    calls.push(`${paginate ? "paginate " : ""}${apiPath}`);
    if (apiPath.endsWith("/commits/main")) return routes.head ?? JSON.stringify({ sha });
    if (apiPath.includes("/commits/")) return routes.ref ?? JSON.stringify({ sha });
    if (apiPath.includes("/workflows/ci.yml/runs")) return routes.runs ?? runs(run());
    if (apiPath.includes("/jobs")) return routes.jobs ?? goodJobs;
    throw new GateError("GATE_API_FAILED", "A GitHub API request failed.");
  };
  return { gh, calls };
}
const dispatchEnv = { REPOSITORY: "owner/repo", EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main", GITHUB_SHA: sha };
const runEnv = {
  REPOSITORY: "owner/repo", EVENT_NAME: "workflow_run", RUN_CONCLUSION: "success", RUN_EVENT: "push", RUN_HEAD_BRANCH: "main", RUN_HEAD_SHA: sha,
  GITHUB_SHA: other,
};
const refusal = (fn: () => unknown): string => {
  try { fn(); } catch (error) { return error instanceof GateError ? error.code : "OTHER"; }
  return "NONE";
};

describe("production gate", () => {
  it("accepts a successful push CI for the tip of main, from either trigger, and asks for slurped job pages", () => {
    for (const env of [runEnv, dispatchEnv]) {
      const fx = fakeGh({});
      expect(productionGate(env, fx.gh)).toEqual({ sha });
      expect(fx.calls.at(-1)).toMatch(/^paginate repos\/owner\/repo\/actions\/runs\/9001\/jobs/);
    }
  });

  it("uses the CI run's commit for workflow_run, never the default-branch SHA", () => {
    expect(productionGate({ ...runEnv, GITHUB_SHA: other }, fakeGh({}).gh).sha).toBe(sha);
  });

  it("refuses a run that did not succeed, was not a push, or was not on main", () => {
    for (const patch of [{ RUN_CONCLUSION: "failure" }, { RUN_CONCLUSION: "cancelled" }, { RUN_CONCLUSION: "" }, { RUN_EVENT: "pull_request" },
      { RUN_EVENT: "workflow_dispatch" }, { RUN_HEAD_BRANCH: "feature" }, { EVENT_NAME: "push" }, { EVENT_NAME: undefined }]) {
      const fx = fakeGh({});
      expect(refusal(() => productionGate({ ...runEnv, ...patch }, fx.gh)), JSON.stringify(patch)).toBe("GATE_REFUSED");
      expect(fx.calls).toHaveLength(0);
    }
    expect(refusal(() => productionGate({ ...dispatchEnv, GITHUB_REF: "refs/heads/feature" }, fakeGh({}).gh))).toBe("GATE_REFUSED");
    expect(refusal(() => productionGate({ ...dispatchEnv, GITHUB_SHA: undefined }, fakeGh({}).gh))).toBe("GATE_CONFIG");
  });

  it("rejects a malformed commit or repository before any request", () => {
    for (const patch of [{ RUN_HEAD_SHA: "abc123" }, { RUN_HEAD_SHA: sha.toUpperCase() }, { RUN_HEAD_SHA: undefined }, { REPOSITORY: "owner" }, { REPOSITORY: undefined }]) {
      const fx = fakeGh({});
      expect(refusal(() => productionGate({ ...runEnv, ...patch }, fx.gh))).toBe("GATE_CONFIG");
      expect(fx.calls).toHaveLength(0);
    }
  });

  it("reports superseded when main has moved on, or the head answer is unusable", () => {
    expect(refusal(() => productionGate(runEnv, fakeGh({ head: JSON.stringify({ sha: other }) }).gh))).toBe("GATE_SUPERSEDED");
    expect(refusal(() => productionGate(runEnv, fakeGh({ head: JSON.stringify({}) }).gh))).toBe("GATE_SUPERSEDED");
    expect(refusal(() => productionGate(runEnv, fakeGh({ head: "[]" }).gh))).toBe("GATE_SUPERSEDED");
    try { productionGate(runEnv, fakeGh({ head: JSON.stringify({ sha: other }) }).gh); } catch (error) { expect((error as Error).message).toContain("superseded"); }
  });

  it("fails closed without a successful push CI run for this exact commit on main", () => {
    for (const listing of [runs(), runs(run({ conclusion: "failure" })), runs(run({ head_sha: other })), runs(run({ event: "pull_request" })),
      runs(run({ head_branch: "feature" })), runs(run({ conclusion: null, status: "in_progress" })), JSON.stringify({ workflow_runs: [null, 3, "x"] })]) {
      expect(refusal(() => productionGate(runEnv, fakeGh({ runs: listing }).gh)), listing).toBe("GATE_NO_CI");
    }
  });

  it("fails closed unless the acceptance job succeeded", () => {
    const only = (...items: unknown[]) => JSON.stringify([jobsPage(...items)]);
    for (const jobs of [only(), only(job("ci", "success")), only(job("acceptance", "failure")), only(job("acceptance", "skipped")),
      only(job("acceptance", "cancelled")), only(job("acceptance", null)), only(job("acceptance", "success"), job("acceptance", "failure")),
      only(job("Acceptance", "success")), only(job("ci / acceptance", "success"))]) {
      expect(refusal(() => productionGate(runEnv, fakeGh({ jobs }).gh)), jobs).toBe("GATE_NO_ACCEPTANCE");
    }
  });

  it("fails closed on malformed GitHub answers", () => {
    expect(refusal(() => productionGate(runEnv, fakeGh({ head: "not json" }).gh))).toBe("GATE_API_INVALID");
    expect(refusal(() => productionGate(runEnv, fakeGh({ runs: "not json" }).gh))).toBe("GATE_API_INVALID");
    expect(refusal(() => productionGate(runEnv, fakeGh({ runs: "[]" }).gh))).toBe("GATE_API_INVALID");
    expect(refusal(() => productionGate(runEnv, fakeGh({ runs: JSON.stringify({ workflow_runs: "x" }) }).gh))).toBe("GATE_API_INVALID");
    expect(refusal(() => productionGate(runEnv, fakeGh({ jobs: "{" }).gh))).toBe("GATE_API_INVALID");
    expect(refusal(() => productionGate(runEnv, fakeGh({ jobs: JSON.stringify([{ nope: 1 }]) }).gh))).toBe("GATE_API_INVALID");
    expect(refusal(() => productionGate(runEnv, fakeGh({ jobs: JSON.stringify(null) }).gh))).toBe("GATE_API_INVALID");
    expect(refusal(() => productionGate(runEnv, () => { throw new GateError("GATE_API_FAILED", "x"); }))).toBe("GATE_API_FAILED");
  });

  it("reads a single un-slurped page and ignores jobs without a usable name", () => {
    expect(jobsOf(jobsPage(job("a", "success"), { id: 2 }, null, { name: "b", conclusion: 3 }))).toEqual([
      { name: "a", conclusion: "success" }, { name: "b", conclusion: null },
    ]);
  });

  it("requires the same acceptance for any branch when called directly", () => {
    const feature = runs(run({ head_branch: "feature" }));
    expect(() => requireAcceptance(fakeGh({ runs: feature }).gh, { repository: "owner/repo", sha })).not.toThrow();
    expect(refusal(() => requireAcceptance(fakeGh({ runs: feature }).gh, { repository: "owner/repo", sha, branch: "main" }))).toBe("GATE_NO_CI");
    expect(refusal(() => requireAcceptance(fakeGh({}).gh, { repository: "bad", sha }))).toBe("GATE_CONFIG");
  });
});

describe("rehearsal gate", () => {
  it("rehearses only the tip of main, started by hand, with the same accepted CI as a release", () => {
    const fx = fakeGh({});
    expect(rehearsalGate(dispatchEnv, fx.gh)).toEqual({ sha });
    expect(fx.calls[0]).toBe("repos/owner/repo/commits/main");
  });

  it("refuses other events, other refs, a superseded commit and missing CI or acceptance", () => {
    for (const patch of [{ EVENT_NAME: "workflow_run" }, { EVENT_NAME: "push" }, { EVENT_NAME: undefined }]) {
      const fx = fakeGh({});
      expect(refusal(() => rehearsalGate({ ...runEnv, ...patch }, fx.gh)), JSON.stringify(patch)).toBe("GATE_REFUSED");
      expect(fx.calls).toHaveLength(0);
    }
    expect(refusal(() => rehearsalGate({ ...dispatchEnv, GITHUB_REF: "refs/heads/feature" }, fakeGh({}).gh))).toBe("GATE_REFUSED");
    expect(refusal(() => rehearsalGate({ ...dispatchEnv, GITHUB_SHA: other }, fakeGh({}).gh))).toBe("GATE_SUPERSEDED");
    expect(refusal(() => rehearsalGate({ ...dispatchEnv, REPOSITORY: "x" }, fakeGh({}).gh))).toBe("GATE_CONFIG");
    expect(refusal(() => rehearsalGate(dispatchEnv, fakeGh({ runs: runs() }).gh))).toBe("GATE_NO_CI");
    expect(refusal(() => rehearsalGate(dispatchEnv, fakeGh({ jobs: JSON.stringify([jobsPage(job("acceptance", "failure"))]) }).gh))).toBe("GATE_NO_ACCEPTANCE");
  });
});

describe("gh transport and gate script", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  function fakeGhBinary(files: Record<string, string>, failing = false) {
    const dir = mkdtempSync(path.join(tmpdir(), "gate-"));
    dirs.push(dir);
    for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
    const script = `#!/bin/sh
for a in "$@"; do last="$a"; done
echo "$@" >> "${dir}/args.log"
${failing ? 'echo "secret-detail https://x ghs_token" >&2; exit 4' : `case "$last" in
  */commits/main) cat "${dir}/head.json" ;;
  */workflows/ci.yml/runs*) cat "${dir}/runs.json" ;;
  */jobs*) cat "${dir}/jobs.json" ;;
  *) exit 1 ;;
esac`}
`;
    writeFileSync(path.join(dir, "gh"), script);
    chmodSync(path.join(dir, "gh"), 0o755);
    return dir;
  }
  const files = { "head.json": JSON.stringify({ sha }), "runs.json": runs(run()), "jobs.json": goodJobs };

  it("runs gh without a shell, with --paginate --slurp only for pagination, and hides stderr", () => {
    const dir = fakeGhBinary(files);
    const gh = ghFromCli({ PATH: `${dir}:${process.env.PATH}`, GH_TOKEN: "unused" });
    expect(JSON.parse(gh("repos/owner/repo/commits/main"))).toEqual({ sha });
    gh("repos/owner/repo/actions/runs/9001/jobs?filter=latest&per_page=100", true);
    const log = readFileSync(path.join(dir, "args.log"), "utf8").trim().split("\n");
    expect(log[0]).toBe("api repos/owner/repo/commits/main");
    expect(log[1]).toBe("api --paginate --slurp repos/owner/repo/actions/runs/9001/jobs?filter=latest&per_page=100");

    const broken = fakeGhBinary(files, true);
    const failing = ghFromCli({ PATH: `${broken}:${process.env.PATH}` });
    let message = "";
    try { failing("repos/owner/repo/commits/main"); } catch (error) { message = (error as Error).message; }
    expect(message).toBe("GATE_API_FAILED: A GitHub API request failed.");
  });

  function runScript(mode: string, env: Record<string, string>, dir: string, outputFile: string) {
    return spawnSync("pnpm", ["exec", "tsx", "scripts/release-gate.ts", mode], {
      cwd: path.resolve(__dirname, ".."), encoding: "utf8",
      env: { NODE_ENV: "test", PATH: `${dir}:${process.env.PATH}`, HOME: process.env.HOME ?? "", GITHUB_OUTPUT: outputFile, ...env },
    });
  }

  it("writes the commit to GITHUB_OUTPUT on success and fails with a value-free error otherwise", () => {
    const dir = fakeGhBinary(files);
    const output = path.join(dir, "out.txt");
    writeFileSync(output, "");
    const ok = runScript("production", runEnv, dir, output);
    expect(ok.status, ok.stderr).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(`sha=${sha}\n`);

    const moved = fakeGhBinary({ ...files, "head.json": JSON.stringify({ sha: other }) });
    const superseded = runScript("production", runEnv, moved, output);
    expect(superseded.status).toBe(1);
    expect(superseded.stderr).toContain("superseded");

    const unexpected = runScript("production", { ...runEnv, REPOSITORY: "owner/repo" }, fakeGhBinary({ ...files, "runs.json": "x" }), output);
    expect(unexpected.status).toBe(1);
    expect(unexpected.stderr).toContain("GATE_API_INVALID");

    expect(runScript("nope", runEnv, dir, output).status).toBe(1);
    expect(runScript("production", runEnv, dir, "").status).toBe(1);
    const crash = spawnSync("pnpm", ["exec", "tsx", "scripts/release-gate.ts", "production"], {
      cwd: path.resolve(__dirname, ".."), encoding: "utf8", env: { NODE_ENV: "test", PATH: "/nonexistent", HOME: process.env.HOME ?? "" },
    });
    expect(crash.status).not.toBe(0);
  });
});
