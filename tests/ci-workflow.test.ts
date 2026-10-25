import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const acceptance = workflow.slice(workflow.indexOf("\n  acceptance:"));

describe("credential-free CI acceptance gate", () => {
  it("installs matching native recovery clients from the signed PostgreSQL repository on a fixed Ubuntu release", () => {
    expect(workflow).toContain("runs-on: ubuntu-24.04");
    expect(workflow).toContain("timeout-minutes: 45");
    expect(workflow).toContain("signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc");
    expect(workflow).toContain("https://apt.postgresql.org/pub/repos/apt noble-pgdg main");
    expect(workflow).toContain("age postgresql-client-17");
    expect(workflow).toContain("/usr/lib/postgresql/17/bin/pg_dump --version");
    expect(workflow).toContain("/usr/lib/postgresql/17/bin/pg_restore --version");
  });

  it("runs even after unsuccessful dependencies and names every required job", () => {
    expect(acceptance).toContain("if: ${{ always() }}");
    expect(acceptance).toContain("needs: [ci, browser, secrets]");
    expect(acceptance).toContain("permissions: {}");
    for (const [key, job] of [["CI", "ci"], ["BROWSER", "browser"], ["SECRETS", "secrets"]]) {
      expect(acceptance).toContain(`${key}_RESULT: \${{ needs.${job}.result }}`);
    }
  });

  it("fails closed for failed, cancelled, skipped or missing dependency results", () => {
    const command = acceptance.match(/        run: \|\n([\s\S]+)$/)?.[1];
    expect(command).toBeDefined();
    const results = ["success", "failure", "cancelled", "skipped", ""];
    for (const ci of results) {
      for (const browser of results) {
        for (const secrets of results) {
          const run = spawnSync("bash", ["-e", "-c", command!], {
            env: { ...process.env, CI_RESULT: ci, BROWSER_RESULT: browser, SECRETS_RESULT: secrets },
            encoding: "utf8",
          });
          expect(run.error).toBeUndefined();
          expect(run.status, JSON.stringify({ ci, browser, secrets })).toBe(
            [ci, browser, secrets].every((result) => result === "success") ? 0 : 1,
          );
        }
      }
    }
  });

  it("pins all action references and never persists checkout credentials", () => {
    const actions = [...workflow.matchAll(/uses: (\S+)/g)].map((match) => match[1]!);
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) expect(action).toMatch(/^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
    const checkouts = workflow.split(/- uses: actions\/checkout@[a-f0-9]{40}[^\n]*\n/).slice(1);
    expect(checkouts).toHaveLength(3);
    for (const checkout of checkouts) {
      expect(checkout.split(/\n\s*- (?:uses|name|run):/)[0]).toContain("persist-credentials: false");
    }
  });

  it("keeps deployment credentials out of PR and synthetic test jobs", () => {
    const secrets = [...workflow.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1]);
    expect(secrets).toEqual(["GITHUB_TOKEN"]);
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).not.toContain("pull_request_target");
  });
});
