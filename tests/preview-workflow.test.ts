import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/preview.yml", import.meta.url), "utf8");
const accepted = workflow.slice(workflow.indexOf("\n  accepted:"), workflow.indexOf("\n  preview:"));
const preview = workflow.slice(workflow.indexOf("\n  preview:"));

describe("protected preview deployment contract", () => {
  it("is manual-only, serialized, preview-scoped and never deploys PR code automatically", () => {
    expect(workflow).toContain("on:\n  workflow_dispatch:");
    expect(workflow).not.toMatch(/^  (?:pull_request|workflow_run|push):/m);
    expect(workflow).toContain("cancel-in-progress: false");
    expect(preview).toContain("needs: accepted");
    expect(preview).toContain("environment: preview");
    expect(preview).not.toContain("--prod");
    expect(preview).not.toContain("environment: production");
  });

  it("requires successful exact-commit push CI and the aggregate acceptance job without deployment secrets", () => {
    expect(accepted).not.toContain("secrets.");
    expect(accepted).toContain("head_sha=$COMMIT&event=push&status=success");
    expect(accepted).toContain('.head_sha == $sha and .head_branch == $branch');
    expect(accepted).toContain('.name == "acceptance"');
    expect(accepted).toContain("grep -qx success");
    expect(preview).toContain("ref: ${{ github.sha }}");
  });

  it("pins tools and actions, uses read-only permissions and does not persist checkout credentials", () => {
    for (const match of workflow.matchAll(/uses: (\S+)/g)) {
      expect(match[1]).toMatch(/^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
    }
    expect(workflow).toContain("permissions:\n  contents: read\n  actions: read");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("vercel@58.4.4");
    expect(workflow).toContain("pnpm install --frozen-lockfile");
  });

  it("refuses drift or pending migrations before building/uploading, without running migrations or seed", () => {
    const configuration = preview.indexOf("previewPreflight(runtime, true)");
    const schema = preview.indexOf("select hash, created_at from drizzle.__drizzle_migrations");
    const build = preview.indexOf("vercel build");
    const protection = preview.indexOf('project.ssoProtection?.deploymentType !== "all"');
    const deploy = preview.indexOf('["deploy", "--prebuilt"');
    expect(configuration).toBeGreaterThan(0);
    expect(schema).toBeGreaterThan(configuration);
    expect(protection).toBeGreaterThan(schema);
    expect(build).toBeGreaterThan(protection);
    expect(deploy).toBeGreaterThan(build);
    expect(preview).toContain("runtime[key] !== process.env[key]");
    expect(preview).toContain('runtime.BETTER_AUTH_URL !== `https://${process.env.PREVIEW_ALIAS}`');
    expect(preview).toContain('["alias", "set", url, process.env.PREVIEW_ALIAS');
    expect(preview).toContain("rows.length !== expected.length");
    expect(preview).toContain("row.hash !== expected[i].hash");
    expect(preview).not.toMatch(/db:migrate|pnpm seed|migrate\(handle/);
  });

  it("never uploads pulled credentials as artifacts and removes the explicit env file even on failure", () => {
    expect(preview).not.toContain("upload-artifact");
    expect(preview).not.toContain("console.log(runtime)");
    expect(preview).toContain("if: ${{ always() }}");
    expect(preview).toContain("rm -f .vercel/.env.preview.local");
  });

  it("parses the actual inline deployment programs", () => {
    const programs = [...workflow.matchAll(/<<'JS'\n([\s\S]*?)\n          JS/g)];
    expect(programs).toHaveLength(4);
    for (const [, program] of programs) {
      const result = spawnSync(process.execPath, ["--input-type=module", "--check"], {
        input: program, encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
    }
  });

  it("executes the actual project protection guard and refuses partially protected aliases without leaking values", () => {
    const directory = mkdtempSync(join(tmpdir(), "protein-kitchen-preview-protection-"));
    try {
      writeFileSync(join(directory, "vercel"), `#!${process.execPath}\nconsole.log(process.env.SYNTHETIC_PROJECT);\n`, { mode: 0o700 });
      const program = [...workflow.matchAll(/<<'JS'\n([\s\S]*?)\n          JS/g)][2]![1]!;
      for (const [project, success] of [
        [{ id: "synthetic", ssoProtection: { deploymentType: "all" } }, true],
        [{ id: "synthetic", ssoProtection: { deploymentType: "prod_deployment_urls_and_all_previews" } }, false],
        [{ id: "wrong-project", ssoProtection: { deploymentType: "all" } }, false],
        [{ id: "synthetic" }, false],
      ] as const) {
        const result = spawnSync(process.execPath, ["--input-type=module"], {
          input: program, encoding: "utf8", env: {
            NODE_ENV: "test", PATH: directory, VERCEL_PROJECT_ID: "synthetic", VERCEL_ORG_ID: "synthetic-team",
            VERCEL_TOKEN: "PRIVATE_SYNTHETIC_VALUE", SYNTHETIC_PROJECT: JSON.stringify(project),
          },
        });
        expect(result.status, result.stderr).toBe(success ? 0 : 1);
        expect(result.stdout + result.stderr).not.toContain("PRIVATE_SYNTHETIC_VALUE");
        if (!success) expect(result.stderr).toContain("Require Vercel Authentication on all deployments and aliases");
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("executes the actual deploy program and refuses implicit production promotion or an unready result", () => {
    const directory = mkdtempSync(join(tmpdir(), "protein-kitchen-preview-target-"));
    try {
      writeFileSync(join(directory, "vercel"), `#!${process.execPath}
console.log(process.argv[2] === "deploy" ? JSON.stringify({ url: "https://synthetic.vercel.app" }) : process.env.SYNTHETIC_INSPECTION);
`, { mode: 0o700 });
      const program = [...workflow.matchAll(/<<'JS'\n([\s\S]*?)\n          JS/g)][3]![1]!;
      for (const [inspection, success] of [
        [{ id: "synthetic", readyState: "READY", target: null }, true],
        [{ id: "synthetic", readyState: "READY", target: "production" }, false],
        [{ id: "synthetic", readyState: "BUILDING", target: null }, false],
      ] as const) {
        const result = spawnSync(process.execPath, ["--input-type=module"], {
          input: program, encoding: "utf8", env: {
            NODE_ENV: "test", PATH: directory, VERCEL_TOKEN: "PRIVATE_SYNTHETIC_VALUE", PREVIEW_ALIAS: "synthetic.vercel.app",
            SYNTHETIC_INSPECTION: JSON.stringify(inspection),
          },
        });
        expect(result.status, result.stderr).toBe(success ? 0 : 1);
        expect(result.stdout + result.stderr).not.toContain("PRIVATE_SYNTHETIC_VALUE");
        if (success) expect(JSON.parse(result.stdout)).toMatchObject({ target: "preview", readyState: "READY" });
        else expect(result.stderr).toContain("Refuse an unready deployment or implicit first-deployment production promotion");
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("the actual configuration guard refuses missing settings without exposing values", () => {
    const program = [...workflow.matchAll(/<<'JS'\n([\s\S]*?)\n          JS/g)][0]![1]!;
    const names = [
      "VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID", "DATABASE_URL",
      "DATABASE_URL_UNPOOLED", "NEON_PROJECT_ID", "NEON_DEVELOPMENT_BRANCH_ID",
      "NEON_PRODUCTION_BRANCH_ID", "DATABASE_NONPRODUCTION_HOST", "DATABASE_DIRECT_NONPRODUCTION_HOST", "PREVIEW_ALIAS",
    ];
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "test", ...Object.fromEntries(names.map((name) => [name, "PRIVATE_SYNTHETIC_VALUE"])),
    };
    for (const missing of [null, ...names]) {
      const result = spawnSync(process.execPath, ["--input-type=module"], {
        input: program, env: missing ? { ...env, [missing]: "" } : env, encoding: "utf8",
      });
      expect(result.status).toBe(missing ? 1 : 0);
      expect(result.stderr).not.toContain("PRIVATE_SYNTHETIC_VALUE");
      if (missing) expect(result.stderr).toContain(`Missing preview settings: ${missing}`);
    }
  });

  it("executes the actual runtime verifier and refuses incomplete settings before opening a database", () => {
    const directory = mkdtempSync(join(tmpdir(), "protein-kitchen-preview-"));
    try {
      for (const name of ["lib", "node_modules", "tsconfig.json"]) {
        symlinkSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), join(directory, name));
      }
      mkdirSync(join(directory, ".vercel"));
      const settings = {
        DATABASE_URL: "PRIVATE_SYNTHETIC_VALUE",
        DATABASE_URL_UNPOOLED: "PRIVATE_SYNTHETIC_VALUE",
        NEON_PROJECT_ID: "synthetic-project",
        NEON_DEVELOPMENT_BRANCH_ID: "br-synthetic-development",
        NEON_PRODUCTION_BRANCH_ID: "br-synthetic-production",
        DATABASE_NONPRODUCTION_HOST: "synthetic.invalid",
        DATABASE_DIRECT_NONPRODUCTION_HOST: "synthetic-direct.invalid",
      };
      writeFileSync(join(directory, ".vercel/.env.preview.local"),
        Object.entries(settings).map(([key, value]) => `${key}=${value}`).join("\n"));
      const program = [...workflow.matchAll(/<<'JS'\n([\s\S]*?)\n          JS/g)][1]![1]!;
      const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module"], {
        cwd: directory, input: program, env: { NODE_ENV: "test", ...settings }, encoding: "utf8", timeout: 10_000,
      });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toContain('"configurationValid":false,"liveBranchVerified":false');
      expect(result.stderr).toContain("Preview preflight refused deployment. No migration or upload occurred.");
      expect(result.stdout + result.stderr).not.toContain("PRIVATE_SYNTHETIC_VALUE");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
