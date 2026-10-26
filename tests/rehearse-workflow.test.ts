import { describe, expect, it } from "vitest";
import { allSteps, expectOrderedCommands, loadWorkflow } from "./helpers/workflow-contract";

const { text, workflow } = loadWorkflow("rehearse-migration.yml");
const gate = workflow.jobs.gate!;
const rehearse = workflow.jobs.rehearse!;

describe("rehearse-migration workflow contract", () => {
  it("is manual only, has no ref input and read-only permissions", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.on.workflow_dispatch).toBeNull();
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(text).not.toContain("pull_request");
    expect(text).not.toContain("inputs.");
    expect(text).not.toContain("production-rehearsal");
  });

  it("gates without secrets or environment and rehearses only the tip of main", () => {
    expect(gate.environment).toBeUndefined();
    expect(gate.permissions).toEqual({ contents: "read", actions: "read" });
    expect(JSON.stringify(gate)).not.toMatch(/secrets\.|vars\./);
    expect(gate.steps.at(-1)!.run).toBe("pnpm deploy:gate rehearsal");
    expect(gate.steps.at(-1)!.env).toMatchObject({ EVENT_NAME: "${{ github.event_name }}" });
    expect(gate.steps.at(-1)!.env).not.toHaveProperty("REF_INPUT");
  });

  it("rehearses in the production environment against a development target, sharing the production concurrency group", () => {
    expect(rehearse.needs).toBe("gate");
    expect(rehearse.environment).toBe("production");
    expect(rehearse.concurrency).toEqual({ group: "production", "cancel-in-progress": false });
    expect(rehearse["timeout-minutes"]).toBe(30);
    expect(rehearse.env).toMatchObject({
      DATABASE_ENV: "development", NEON_PROJECT_ID: "${{ vars.NEON_PROJECT_ID }}",
      NEON_PRODUCTION_BRANCH_ID: "${{ vars.NEON_PRODUCTION_BRANCH_ID }}", NEON_DATABASE_NAME: "${{ vars.NEON_DATABASE_NAME }}",
      NEON_ROLE_NAME: "${{ vars.NEON_ROLE_NAME }}",
    });
    expect(rehearse.env).not.toHaveProperty("NEON_API_KEY");
    expect(rehearse.env).not.toHaveProperty("DEPLOYMENT_ENVIRONMENT");
    expect(rehearse.env).not.toHaveProperty("DATABASE_URL");
    const checkout = rehearse.steps.find((s) => s.uses?.startsWith("actions/checkout"))!;
    expect(checkout.with).toMatchObject({ ref: "${{ needs.gate.outputs.sha }}", "persist-credentials": false });
  });

  it("gives NEON_API_KEY only to the steps that call Neon, never to checkout or install", () => {
    expect([...new Set([...text.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]))]).toEqual(["NEON_API_KEY"]);
    const withKey = rehearse.steps.filter((s) => s.env?.NEON_API_KEY === "${{ secrets.NEON_API_KEY }}");
    for (const needle of ["db:rehearsal create", "db:check:production", "db:migrate:postgres", "pnpm seed", "db:rehearsal delete"]) {
      expect(withKey.some((s) => (s.run ?? "").includes(needle)), needle).toBe(true);
    }
    for (const step of rehearse.steps) {
      if (step.uses || step.run === "pnpm install --frozen-lockfile") expect(step.env).toBeUndefined();
    }
  });

  it("runs create, count, check, migrate, seed, check, count, compare in order", () => {
    expectOrderedCommands(rehearse.steps, [
      "pnpm db:rehearsal create", "pnpm db:rehearsal counts \"$RUNNER_TEMP/before.json\"",
      "db:check:production --target=rehearsal --phase=pre-migrate", "pnpm db:migrate:postgres", "pnpm seed",
      "db:check:production --target=rehearsal --phase=pre-deploy", "pnpm db:rehearsal counts \"$RUNNER_TEMP/after.json\"",
      "pnpm db:rehearsal compare \"$RUNNER_TEMP/before.json\" \"$RUNNER_TEMP/after.json\"",
    ]);
    const migrate = rehearse.steps.find((s) => (s.run ?? "").includes("db:migrate:postgres"))!;
    expect(migrate.run).toContain("$SECONDS");
    expect(migrate.run).toContain("$GITHUB_STEP_SUMMARY");
    expect(text).not.toMatch(/db:snapshot:production|vercel/);
  });

  it("always deletes the branch and removes the temporary files", () => {
    const last = rehearse.steps.at(-1)!;
    expect(last.if).toBe("${{ always() }}");
    expect(last.run).toContain("pnpm db:rehearsal delete");
    expect(last.run).toContain("before.json");
    expect(last.run).toContain("after.json");
  });

  it("pins actions, drops checkout credentials, uploads nothing and prints no credential", () => {
    for (const step of allSteps(workflow)) {
      if (step.uses) expect(step.uses).toMatch(/^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
      if (step.uses?.startsWith("actions/checkout")) expect(step.with?.["persist-credentials"]).toBe(false);
    }
    expect(text).not.toContain("upload-artifact");
    expect(text).not.toMatch(/\becho\b[^\n]*(NEON_API_KEY|DATABASE_URL)/);
    expect(text).not.toMatch(/secrets:\s*inherit/);
  });
});
