import { authConfiguration } from "../auth/config";
import { blobConfiguration } from "../blob/config";
import { runtimeTarget } from "../db/postgres/runtime-target";
import { validatePostgresTarget } from "../db/postgres/target";
import { verifyNonProductionBranch } from "../db/postgres/verify-branch";

type Environment = Readonly<Record<string, string | undefined>>;
export type PreviewCheck = "environment" | "database-pair" | "branch-pins" | "auth" | "private-photos" | "side-effects" | "fixture-bypasses" | "public-secrets" | "live-branch";
export type PreviewReport = { configurationValid: boolean; liveBranchVerified: boolean; failed: PreviewCheck[] };

/** Configuration evidence only: never a deployment authorization or provider/device acceptance. */
export async function previewPreflight(
  env: Environment, live = false, verify = verifyNonProductionBranch,
): Promise<PreviewReport> {
  const failed: PreviewCheck[] = [];
  function check(code: PreviewCheck, run: () => void) {
    try { run(); } catch { failed.push(code); }
  }
  const refuse = () => { throw new Error("Preview configuration refused."); };
  check("environment", () => {
    if (env.VERCEL !== "1" || env.VERCEL_ENV !== "preview" || env.NODE_ENV !== "production" || env.DATABASE_ENV !== "preview") refuse();
  });
  check("database-pair", () => {
    const target = runtimeTarget(env), pooled = validatePostgresTarget(target);
    const direct = validatePostgresTarget({
      ...target, connectionString: env.DATABASE_URL_UNPOOLED ?? "",
      nonProductionHost: env.DATABASE_DIRECT_NONPRODUCTION_HOST,
    });
    const [label, ...domain] = direct.hostname.split(".");
    if (!direct.hostname.endsWith(".neon.tech") || label!.endsWith("-pooler") ||
        pooled.hostname !== `${label}-pooler.${domain.join(".")}` ||
        pooled.pathname !== direct.pathname || pooled.username !== direct.username || pooled.password !== direct.password ||
        (pooled.port || "5432") !== (direct.port || "5432")) refuse();
  });
  check("branch-pins", () => {
    if (!/^[a-z0-9-]+$/.test(env.NEON_PROJECT_ID ?? "") ||
        !/^br-[a-z0-9-]+$/.test(env.NEON_DEVELOPMENT_BRANCH_ID ?? "") ||
        !/^br-[a-z0-9-]+$/.test(env.NEON_PRODUCTION_BRANCH_ID ?? "") ||
        env.NEON_DEVELOPMENT_BRANCH_ID === env.NEON_PRODUCTION_BRANCH_ID || !env.NEON_API_KEY) refuse();
  });
  check("auth", () => {
    const auth = authConfiguration(env);
    if (new URL(auth.baseURL).protocol !== "https:" || auth.bootstrapSecret ||
        ["localhost", "127.0.0.1", "[::1]"].includes(new URL(auth.baseURL).hostname)) refuse();
  });
  check("private-photos", () => {
    const photos = blobConfiguration(env);
    if (photos.kind !== "neon" || !photos.readOnly) refuse();
  });
  check("side-effects", () => {
    if (["STATE_SYNC_ENABLED", "REMINDER_SCHEDULER_ENABLED", "VAULT_ENABLED"].some((key) => env[key] && env[key] !== "false") ||
        ["STATE_SYNC_SCHEDULER_SECRET", "REMINDER_SCHEDULER_SECRET", "VAULT_GITHUB_PRIVATE_KEY", "VAPID_PRIVATE_KEY", "RESEND_API_KEY"].some((key) => !!env[key])) refuse();
  });
  check("fixture-bypasses", () => {
    if (["AUTH_TEST_MAILBOX", "STATE_SYNC_TEST_GITHUB_URL", "REMINDER_TEST_PUSH_URL"].some((key) => env[key] !== undefined)) refuse();
  });
  check("public-secrets", () => {
    if (Object.keys(env).some((key) => key.startsWith("NEXT_PUBLIC_") && !!env[key] &&
        /SECRET|TOKEN|PASSWORD|PRIVATE_KEY|DATABASE|API_KEY|ACCESS_KEY|BOOTSTRAP/.test(key))) refuse();
  });
  const configurationValid = failed.length === 0;
  let liveBranchVerified = false;
  if (live && configurationValid) {
    try {
      await verify(runtimeTarget(env), env);
      await verify({
        ...runtimeTarget(env), connectionString: env.DATABASE_URL_UNPOOLED!,
        nonProductionHost: env.DATABASE_DIRECT_NONPRODUCTION_HOST,
      }, env);
      liveBranchVerified = true;
    } catch { failed.push("live-branch"); }
  }
  return { configurationValid, liveBranchVerified, failed };
}
