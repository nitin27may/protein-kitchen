import fs from "node:fs";
import path from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { z } from "zod";
import { postgresMigrationTarget } from "../db/postgres/migration-target";
import type { NeonControlPlane } from "../db/postgres/neon-control-plane";
import { directHostOf, isPoolerHost, ProductionGuardError } from "../db/postgres/production-guard";
import { productionDirectTarget, productionPooledTarget } from "../db/postgres/production-target";
import { validatePostgresTarget } from "../db/postgres/target";
import { verifyNonProductionBranch } from "../db/postgres/verify-branch";
import { productionPins, verifyProductionBranch } from "../db/postgres/verify-production";

/**
 * Read-only production sanity check. Everything here returns stable codes and counts; no function ever places a
 * configuration value, URL, credential or database-derived string in a result.
 */

type Environment = Readonly<Record<string, string | undefined>>;

export type Phase = "pre-migrate" | "pre-deploy";
export type Severity = "ok" | "warn" | "fail";

export const checkCodes = [
  "CONFIG_OK", "CONFIG_MISSING", "CONFIG_MALFORMED", "CONFIG_URL_PAIR_MISMATCH", "CONFIG_ORIGIN_MISMATCH",
  "CONFIG_FORBIDDEN_SET", "CONFIG_FLAG_ENABLED", "CONFIG_VALUE_MISMATCH",
  "NEON_OK", "NEON_CONFIG_MISSING", "NEON_UNREACHABLE", "NEON_INVALID", "NEON_PROJECT_MISMATCH",
  "NEON_BRANCH_MISMATCH", "NEON_BRANCH_NOT_READY", "NEON_ENDPOINT_MISMATCH",
  "CONNECT_OK", "CONNECT_FAILED", "SERVER_VERSION_UNSUPPORTED",
  "LEDGER_EXACT", "LEDGER_PENDING", "LEDGER_DIVERGENT",
  "SCHEMA_OK", "SCHEMA_DRIFT", "SCHEMA_SKIPPED",
  "LIBRARY_OK", "LIBRARY_STALE", "LIBRARY_MISSING",
  "SNAPSHOT_OK", "SNAPSHOT_STALE", "SNAPSHOT_MISSING",
  "ROLE_READ_ONLY", "ROLE_WRITE_CAPABLE", "ROLE_NOT_ENFORCED",
  "RUN_REFUSED_FLAG", "SKIPPED_PREREQUISITE", "CHECK_ERROR",
] as const;
export type CheckCode = (typeof checkCodes)[number];

export interface CheckResult {
  check: string;
  severity: Severity;
  code: CheckCode;
  /** Fixed vocabulary only: variable names, counts and phase names. */
  detail?: string;
}

const result = (check: string, severity: Severity, code: CheckCode, detail?: string): CheckResult =>
  detail === undefined ? { check, severity, code } : { check, severity, code, detail };

export function formatResult(r: CheckResult): string {
  return [r.severity.toUpperCase(), r.check, r.code, r.detail].filter((part) => part !== undefined).join(" ");
}

export function summarise(results: readonly CheckResult[], phase: Phase | "runtime-manifest"): string {
  return `RESULT ${results.some((r) => r.severity === "fail") ? "FAIL" : "PASS"} phase=${phase}`;
}

export type CheckTarget = "production" | "rehearsal";
export interface CheckArguments { phase: Phase; remoteReadOnly: boolean; target: CheckTarget; runtimeManifest?: string }

const USAGE = "Usage: pnpm db:check:production [--phase=pre-migrate|pre-deploy] [--remote-read-only] [--target=rehearsal] | --runtime-manifest=<file>";

export function parseCheckArguments(argv: readonly string[]): CheckArguments {
  let phase: Phase = "pre-deploy", remoteReadOnly = false, target: CheckTarget = "production", runtimeManifest: string | undefined;
  for (const argument of argv) {
    if (argument === "--remote-read-only") remoteReadOnly = true;
    else if (argument === "--phase=pre-migrate") phase = "pre-migrate";
    else if (argument === "--phase=pre-deploy") phase = "pre-deploy";
    else if (argument === "--target=rehearsal") target = "rehearsal";
    else if (argument.startsWith("--runtime-manifest=") && argument.length > "--runtime-manifest=".length) {
      runtimeManifest = argument.slice("--runtime-manifest=".length);
    } else throw new Error(USAGE);
  }
  // The manifest check reads one local file and nothing else; it does not combine with a database check.
  if (runtimeManifest !== undefined && (target !== "production" || remoteReadOnly)) throw new Error(USAGE);
  return runtimeManifest === undefined ? { phase, remoteReadOnly, target } : { phase, remoteReadOnly, target, runtimeManifest };
}

/** Running in the approved CI runner needs no flag; anything else is a laptop that must opt in to a remote read. */
export const isCiRun = (env: Environment) => env.GITHUB_ACTIONS === "true";

export function requireRemoteFlag(env: Environment, args: CheckArguments): CheckResult | undefined {
  return !isCiRun(env) && !args.remoteReadOnly ? result("run", "fail", "RUN_REFUSED_FLAG", "pass=--remote-read-only") : undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// (1) Configuration
// ---------------------------------------------------------------------------------------------------------------

const FORBIDDEN = [
  "HOUSEHOLD_BOOTSTRAP_SECRET", "AUTH_TEST_MAILBOX", "STATE_SYNC_TEST_GITHUB_URL", "REMINDER_TEST_PUSH_URL",
  "HOUSEHOLD_OWNER_EMAIL",
  // Credentials of features that are off at launch.
  "VAPID_PRIVATE_KEY", "REMINDER_SCHEDULER_SECRET", "STATE_SYNC_SCHEDULER_SECRET",
  "STATE_GITHUB_PRIVATE_KEY", "VAULT_GITHUB_PRIVATE_KEY",
] as const;
const FLAGS = ["STATE_SYNC_ENABLED", "REMINDER_SCHEDULER_ENABLED", "VAULT_ENABLED"] as const;
const present = (env: Environment, key: string) => !!env[key]?.trim();

function missing(env: Environment, keys: readonly string[]): string[] {
  return keys.filter((key) => !present(env, key));
}

function databaseConfiguration(env: Environment): CheckResult {
  const check = "config.database";
  const absent = missing(env, ["DATABASE_URL", "DATABASE_URL_UNPOOLED", "DATABASE_PRODUCTION_HOST", "DATABASE_DIRECT_PRODUCTION_HOST"]);
  if (env.DATABASE_ENV !== "production") absent.unshift("DATABASE_ENV");
  if (absent.length) return result(check, "fail", "CONFIG_MISSING", absent.join(","));
  let pooled: URL, direct: URL;
  try {
    pooled = validatePostgresTarget(productionPooledTarget(env));
    direct = validatePostgresTarget(productionDirectTarget(env));
  } catch (error) {
    // A pin or pooler/direct mix-up is a pair problem; anything else is a malformed URL.
    if (error instanceof ProductionGuardError) return result(check, "fail", "CONFIG_URL_PAIR_MISMATCH", "pins");
    return result(check, "fail", "CONFIG_MALFORMED", "database");
  }
  if (!pooled.hostname.endsWith(".neon.tech") || !isPoolerHost(pooled.hostname) || isPoolerHost(direct.hostname) ||
      directHostOf(pooled.hostname) !== direct.hostname || pooled.pathname !== direct.pathname ||
      pooled.username !== direct.username || pooled.password !== direct.password ||
      (pooled.port || "5432") !== (direct.port || "5432")) {
    return result(check, "fail", "CONFIG_URL_PAIR_MISMATCH", "pair");
  }
  return result(check, "ok", "CONFIG_OK");
}

function originOf(value: string | undefined): string | undefined {
  try {
    const url = new URL(value ?? "");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") return undefined;
    return url.origin;
  } catch { return undefined; }
}

function authConfiguration(env: Environment): CheckResult {
  const check = "config.auth";
  const absent = missing(env, ["BETTER_AUTH_URL", "PRODUCTION_ORIGIN", "BETTER_AUTH_SECRET"]);
  if (absent.length) return result(check, "fail", "CONFIG_MISSING", absent.join(","));
  const configured = originOf(env.BETTER_AUTH_URL), expected = originOf(env.PRODUCTION_ORIGIN);
  if (!configured || !expected || env.BETTER_AUTH_SECRET!.length < 32) return result(check, "fail", "CONFIG_MALFORMED", "auth");
  if (configured !== expected) return result(check, "fail", "CONFIG_ORIGIN_MISMATCH");
  return result(check, "ok", "CONFIG_OK");
}

function mailConfiguration(env: Environment): CheckResult {
  const check = "config.mail";
  const absent = missing(env, ["RESEND_API_KEY", "AUTH_EMAIL_FROM"]);
  if (absent.length) return result(check, "fail", "CONFIG_MISSING", absent.join(","));
  if (!z.string().email().safeParse(env.AUTH_EMAIL_FROM).success) return result(check, "fail", "CONFIG_MALFORMED", "AUTH_EMAIL_FROM");
  return result(check, "ok", "CONFIG_OK");
}

function neonConfiguration(env: Environment): CheckResult {
  const check = "config.neon";
  const absent = missing(env, ["NEON_PROJECT_ID", "NEON_PRODUCTION_BRANCH_ID", "NEON_API_KEY"]);
  if (absent.length) return result(check, "fail", "CONFIG_MISSING", absent.join(","));
  try { productionPins(env); } catch { return result(check, "fail", "CONFIG_MALFORMED", "neon-pins"); }
  return result(check, "ok", "CONFIG_OK");
}

export function checkConfiguration(env: Environment): CheckResult[] {
  const forbidden = FORBIDDEN.filter((key) => present(env, key));
  const enabled = FLAGS.filter((key) => present(env, key) && env[key]!.trim() !== "false");
  return [
    databaseConfiguration(env), authConfiguration(env), mailConfiguration(env), neonConfiguration(env),
    forbidden.length ? result("config.forbidden", "fail", "CONFIG_FORBIDDEN_SET", forbidden.join(",")) : result("config.forbidden", "ok", "CONFIG_OK"),
    enabled.length ? result("config.flags", "fail", "CONFIG_FLAG_ENABLED", enabled.join(",")) : result("config.flags", "ok", "CONFIG_OK"),
  ];
}

/**
 * Rehearsal target: the development-target rules for a Neon branch of production. Auth, mail and snapshot checks do not
 * apply (the branch has no secrets of its own to verify), but the ledger, schema and library checks do.
 */
export function checkRehearsalConfiguration(env: Environment): CheckResult[] {
  const check = "config.rehearsal";
  const absent = missing(env, ["DATABASE_URL_UNPOOLED", "DATABASE_NONPRODUCTION_HOST", "NEON_PROJECT_ID", "NEON_PRODUCTION_BRANCH_ID", "NEON_DEVELOPMENT_BRANCH_ID", "NEON_API_KEY"]);
  if (env.DATABASE_ENV !== "development") absent.unshift("DATABASE_ENV");
  if (absent.length) return [result(check, "fail", "CONFIG_MISSING", absent.join(","))];
  try {
    const url = validatePostgresTarget(postgresMigrationTarget(env));
    if (!url.hostname.endsWith(".neon.tech")) return [result(check, "fail", "CONFIG_MALFORMED", "host")];
  } catch {
    return [result(check, "fail", "CONFIG_URL_PAIR_MISMATCH", "pins")];
  }
  if (env.NEON_DEVELOPMENT_BRANCH_ID === env.NEON_PRODUCTION_BRANCH_ID) return [result(check, "fail", "NEON_BRANCH_MISMATCH", "same-as-production")];
  return [result(check, "ok", "CONFIG_OK")];
}

export async function checkRehearsalNeon(env: Environment, request: typeof fetch = fetch): Promise<CheckResult> {
  const check = "neon";
  try {
    await verifyNonProductionBranch(postgresMigrationTarget(env), env, request);
    return result(check, "ok", "NEON_OK");
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("could not reach")) return result(check, "fail", "NEON_UNREACHABLE");
    if (message.includes("requires NEON_PROJECT_ID")) return result(check, "fail", "NEON_CONFIG_MISSING");
    if (message.includes("incomplete") || message.includes("invalid JSON") || message.includes("failed (HTTP")) return result(check, "fail", "NEON_INVALID");
    return result(check, "fail", "NEON_BRANCH_MISMATCH");
  }
}

// ---------------------------------------------------------------------------------------------------------------
// (2) Neon control plane
// ---------------------------------------------------------------------------------------------------------------

const neonCodes: Record<string, CheckCode> = {
  PRODUCTION_NEON_CONFIG_MISSING: "NEON_CONFIG_MISSING", PRODUCTION_NEON_UNREACHABLE: "NEON_UNREACHABLE",
  PRODUCTION_NEON_INVALID: "NEON_INVALID", PRODUCTION_BRANCH_MISMATCH: "NEON_BRANCH_MISMATCH",
  PRODUCTION_BRANCH_NOT_READY: "NEON_BRANCH_NOT_READY", PRODUCTION_ENDPOINT_MISMATCH: "NEON_ENDPOINT_MISMATCH",
};

export async function checkNeon(env: Environment, plane: NeonControlPlane): Promise<CheckResult> {
  const check = "neon";
  try {
    const { project } = productionPins(env);
    if ((await plane.project(project)).id !== project) return result(check, "fail", "NEON_PROJECT_MISMATCH");
    // Both the pooled runtime endpoint and the direct migration endpoint must belong to the production branch.
    await verifyProductionBranch(productionDirectTarget(env), env, plane);
    await verifyProductionBranch(productionPooledTarget(env), env, plane);
    return result(check, "ok", "NEON_OK");
  } catch (error) {
    const code = error instanceof ProductionGuardError ? neonCodes[error.code] : undefined;
    return result(check, "fail", code ?? "NEON_INVALID");
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Database access: a query function that can only read
// ---------------------------------------------------------------------------------------------------------------

export interface Queryable {
  query(text: string): Promise<{ rows: Record<string, unknown>[] }>;
}

const ALLOWED = /^\s*(begin read only|rollback|set local statement_timeout\b|select\b|show\b)/i;

/** Refuses anything but a single read statement, so a later edit can not turn the check into a writer. */
export function readOnlyGuard(inner: Queryable): Queryable {
  return {
    query(text) {
      const body = text.trim().replace(/;\s*$/, "");
      if (!ALLOWED.test(body) || body.includes(";")) throw new Error("CHECK_ERROR: only single read statements are allowed.");
      return inner.query(text);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// (3) Connectivity and server version
// ---------------------------------------------------------------------------------------------------------------

export const MIN_SERVER_MAJOR = 14;

export async function checkServer(q: Queryable): Promise<CheckResult> {
  const check = "connect";
  const { rows } = await q.query("show server_version_num");
  const number = Number(rows[0]?.server_version_num);
  if (!Number.isInteger(number)) return result(check, "fail", "CONNECT_FAILED", "version");
  const major = Math.floor(number / 10_000);
  return major < MIN_SERVER_MAJOR
    ? result(check, "fail", "SERVER_VERSION_UNSUPPORTED", `major=${major}`)
    : result(check, "ok", "CONNECT_OK", `major=${major}`);
}

// ---------------------------------------------------------------------------------------------------------------
// (4) Migration ledger
// ---------------------------------------------------------------------------------------------------------------

export interface ExpectedMigration { hash: string; folderMillis: number }
export interface LedgerRow { hash: string; created_at: string | number | bigint }
export type LedgerState = { state: "exact" | "divergent"; applied: number; pending: 0 } | { state: "pending"; applied: number; pending: number };

export function compareLedger(rows: readonly LedgerRow[], expected: readonly ExpectedMigration[]): LedgerState {
  const prefix = rows.length <= expected.length &&
    rows.every((row, i) => row.hash === expected[i]!.hash && Number(row.created_at) === expected[i]!.folderMillis);
  if (!prefix) return { state: "divergent", applied: rows.length, pending: 0 };
  return rows.length === expected.length
    ? { state: "exact", applied: rows.length, pending: 0 }
    : { state: "pending", applied: rows.length, pending: expected.length - rows.length };
}

export function ledgerResult(ledger: LedgerState, phase: Phase): CheckResult {
  const check = "ledger";
  if (ledger.state === "divergent") return result(check, "fail", "LEDGER_DIVERGENT");
  if (ledger.state === "exact") return result(check, "ok", "LEDGER_EXACT", `applied=${ledger.applied}`);
  return result(check, phase === "pre-migrate" ? "ok" : "fail", "LEDGER_PENDING", `pending=${ledger.pending}`);
}

export async function readLedger(q: Queryable): Promise<LedgerRow[]> {
  const exists = await q.query("select to_regclass('drizzle.__drizzle_migrations') is not null as present");
  if (!exists.rows[0]?.present) return [];
  const { rows } = await q.query("select hash, created_at from drizzle.__drizzle_migrations order by created_at, id");
  return rows.map((row) => ({ hash: String(row.hash), created_at: row.created_at as string | number | bigint }));
}

// ---------------------------------------------------------------------------------------------------------------
// (5) Schema drift against the drizzle snapshot
// ---------------------------------------------------------------------------------------------------------------

export type SchemaShape = Map<string, Set<string>>;

const snapshotSchema = z.object({
  tables: z.record(z.object({ name: z.string(), schema: z.string().optional(), columns: z.record(z.object({ name: z.string() })) })),
});

export function snapshotShape(json: unknown): SchemaShape {
  const parsed = snapshotSchema.parse(json);
  const shape: SchemaShape = new Map();
  for (const table of Object.values(parsed.tables)) {
    if (table.schema && table.schema !== "public") continue;
    shape.set(table.name, new Set(Object.values(table.columns).map((column) => column.name)));
  }
  return shape;
}

export async function readSchemaShape(q: Queryable): Promise<SchemaShape> {
  const { rows } = await q.query(
    "select c.table_name, c.column_name from information_schema.columns c " +
    "join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name " +
    "where c.table_schema = 'public' and t.table_type = 'BASE TABLE'",
  );
  const shape: SchemaShape = new Map();
  for (const row of rows) {
    const table = String(row.table_name);
    if (!shape.has(table)) shape.set(table, new Set());
    shape.get(table)!.add(String(row.column_name));
  }
  return shape;
}

export function schemaResult(expected: SchemaShape | undefined, actual: SchemaShape): CheckResult {
  const check = "schema";
  if (!expected) return result(check, "fail", "SCHEMA_SKIPPED", "no-snapshot");
  const tables = [...expected.keys()];
  const missingTables = tables.filter((table) => !actual.has(table)).length;
  const extraTables = [...actual.keys()].filter((table) => !expected.has(table)).length;
  let missingColumns = 0, extraColumns = 0;
  for (const [table, columns] of expected) {
    const found = actual.get(table);
    if (!found) continue;
    missingColumns += [...columns].filter((column) => !found.has(column)).length;
    extraColumns += [...found].filter((column) => !columns.has(column)).length;
  }
  return missingTables + extraTables + missingColumns + extraColumns === 0
    ? result(check, "ok", "SCHEMA_OK", `tables=${tables.length}`)
    : result(check, "fail", "SCHEMA_DRIFT",
      `missing_tables=${missingTables},extra_tables=${extraTables},missing_columns=${missingColumns},extra_columns=${extraColumns}`);
}

// ---------------------------------------------------------------------------------------------------------------
// (6) Library seed version
// ---------------------------------------------------------------------------------------------------------------

/** `undefined` means the library table or row does not exist. */
export async function readLibraryVersion(q: Queryable): Promise<string | undefined> {
  const exists = await q.query("select to_regclass('public.library_state') is not null as present");
  if (!exists.rows[0]?.present) return undefined;
  // Column-agnostic, so a drifted library table is reported as drift rather than aborting the read-only transaction.
  const { rows } = await q.query("select to_jsonb(l) ->> 'version' as version from library_state l where to_jsonb(l) ->> 'key' = 'library'");
  return typeof rows[0]?.version === "string" ? rows[0].version : undefined;
}

export function libraryResult(databaseVersion: string | undefined, localVersion: string, phase: Phase): CheckResult {
  const check = "library";
  // Before the migration the seed legitimately lags; deployment needs the exact local fingerprint.
  const lag: Severity = phase === "pre-migrate" ? "warn" : "fail";
  if (databaseVersion === undefined) return result(check, lag, "LIBRARY_MISSING");
  return databaseVersion === localVersion ? result(check, "ok", "LIBRARY_OK") : result(check, lag, "LIBRARY_STALE");
}

// ---------------------------------------------------------------------------------------------------------------
// (7) Pre-deploy snapshot branch age
// ---------------------------------------------------------------------------------------------------------------

export const SNAPSHOT_PREFIX = "pre-deploy-";
export const SNAPSHOT_MAX_AGE_MINUTES = 60;

export function snapshotResult(
  branches: readonly { name: string; created_at: string }[], now: Date, phase: Phase, maxAgeMinutes = SNAPSHOT_MAX_AGE_MINUTES,
): CheckResult {
  const check = "snapshot";
  const lag: Severity = phase === "pre-migrate" ? "warn" : "fail";
  const times = branches.filter((branch) => branch.name.startsWith(SNAPSHOT_PREFIX))
    .map((branch) => Date.parse(branch.created_at)).filter((time) => Number.isFinite(time));
  if (!times.length) return result(check, lag, "SNAPSHOT_MISSING");
  const ageMinutes = Math.max(0, Math.floor((now.getTime() - Math.max(...times)) / 60_000));
  return ageMinutes > maxAgeMinutes
    ? result(check, lag, "SNAPSHOT_STALE", `age_min=${ageMinutes},max_min=${maxAgeMinutes}`)
    : result(check, "ok", "SNAPSHOT_OK", `age_min=${ageMinutes}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Role: refuse a write-capable role when running from a laptop
// ---------------------------------------------------------------------------------------------------------------

export async function roleResult(q: Queryable, env: Environment): Promise<CheckResult> {
  const check = "role";
  if (isCiRun(env)) return result(check, "ok", "ROLE_NOT_ENFORCED");
  const { rows } = await q.query(
    "select r.rolsuper as superuser, " +
    "case when to_regclass('public.library_state') is null then false else " +
    "(has_table_privilege(current_user, 'public.library_state', 'INSERT') or " +
    "has_table_privilege(current_user, 'public.library_state', 'UPDATE') or " +
    "has_table_privilege(current_user, 'public.library_state', 'DELETE')) end as table_write, " +
    "has_schema_privilege(current_user, 'public', 'CREATE') as schema_create " +
    "from pg_roles r where r.rolname = current_user",
  );
  const row = rows[0];
  return !row || row.superuser || row.table_write || row.schema_create
    ? result(check, "fail", "ROLE_WRITE_CAPABLE")
    : result(check, "ok", "ROLE_READ_ONLY");
}

// ---------------------------------------------------------------------------------------------------------------
// Local artifacts: migration folder and snapshots
// ---------------------------------------------------------------------------------------------------------------

export interface MigrationArtifacts { expected: ExpectedMigration[]; snapshots: SchemaShape[] }

/** `snapshots[i]` is the schema after migration `i` has been applied. */
export function loadMigrationArtifacts(folder: string): MigrationArtifacts {
  const expected = readMigrationFiles({ migrationsFolder: folder }).map((m) => ({ hash: m.hash, folderMillis: m.folderMillis }));
  const journal = z.object({ entries: z.array(z.object({ idx: z.number() })) })
    .parse(JSON.parse(fs.readFileSync(path.join(folder, "meta", "_journal.json"), "utf8")));
  const snapshots = journal.entries.map((entry) =>
    snapshotShape(JSON.parse(fs.readFileSync(path.join(folder, "meta", `${String(entry.idx).padStart(4, "0")}_snapshot.json`), "utf8"))));
  return { expected, snapshots };
}

// ---------------------------------------------------------------------------------------------------------------
// Orchestration of the database-backed checks
// ---------------------------------------------------------------------------------------------------------------

export interface DatabaseCheckInput {
  client: Queryable;
  env: Environment;
  phase: Phase;
  artifacts: MigrationArtifacts;
  localLibraryVersion: string;
  /** Required for the production target (snapshot age); a rehearsal branch has no snapshot check. */
  plane?: NeonControlPlane;
  target?: CheckTarget;
  now?: Date;
}

/** Runs checks 3 to 7 and the role check inside BEGIN READ ONLY, always rolling back. */
export async function runDatabaseChecks(input: DatabaseCheckInput): Promise<CheckResult[]> {
  const q = readOnlyGuard(input.client);
  const results: CheckResult[] = [];
  await q.query("begin read only");
  try {
    await q.query("set local statement_timeout = 15000");
    results.push(await checkServer(q));
    results.push(await roleResult(q, input.env));
    const ledger = compareLedger(await readLedger(q), input.artifacts.expected);
    results.push(ledgerResult(ledger, input.phase));
    // Compare with the schema of the last applied migration, so a pending migration is not reported as drift.
    const expectedShape = ledger.state === "divergent" ? undefined
      : ledger.applied === 0 ? new Map() : input.artifacts.snapshots[ledger.applied - 1];
    results.push(ledger.state === "divergent"
      ? result("schema", "fail", "SCHEMA_SKIPPED", "ledger-divergent")
      : schemaResult(expectedShape, await readSchemaShape(q)));
    results.push(libraryResult(await readLibraryVersion(q), input.localLibraryVersion, input.phase));
  } finally {
    await q.query("rollback");
  }
  if (input.target === "rehearsal") return results;
  try {
    const { project } = productionPins(input.env);
    results.push(snapshotResult(await input.plane!.branches(project), input.now ?? new Date(), input.phase));
  } catch {
    results.push(result("snapshot", input.phase === "pre-migrate" ? "warn" : "fail", "NEON_UNREACHABLE"));
  }
  return results;
}

// ---------------------------------------------------------------------------------------------------------------
// (8) Vercel production runtime manifest
// ---------------------------------------------------------------------------------------------------------------

/**
 * Flags that must be the plain value `false` on the Vercel production runtime. One name per line so another change
 * (for example the photo review gate) adds one line without a merge conflict.
 */
export const RUNTIME_OFF_FLAGS = [
  "STATE_SYNC_ENABLED",
  "REMINDER_SCHEDULER_ENABLED",
  "VAULT_ENABLED",
  "PHOTO_REVIEW_ENABLED",
  "LEGACY_IMPORT_ENABLED",
] as const;

/** Sensitive on Vercel: must exist and must not be stored as a plain value. */
const RUNTIME_SECRETS = [
  "DATABASE_URL", "BETTER_AUTH_SECRET", "RESEND_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "SIGNUP_ALLOWLIST",
] as const;

/** Plain on Vercel: must exist as a plain value. */
const RUNTIME_PLAIN = [
  "DATABASE_ENV", "DATABASE_PRODUCTION_HOST", "NEON_PROJECT_ID", "NEON_PRODUCTION_BRANCH_ID", "BETTER_AUTH_URL",
  "AUTH_EMAIL_FROM", "BLOB_STORE", "BLOB_BUCKET", "AWS_ENDPOINT_URL_S3", "AWS_REGION", "APP_TZ", "MAIL_DAILY_CAP",
] as const;

/** Plain runtime value to compare with the GitHub-side value (the job environment). */
const RUNTIME_EQUALS: readonly { runtime: string; github: string; origin?: true; optionalGithub?: true }[] = [
  { runtime: "BETTER_AUTH_URL", github: "PRODUCTION_ORIGIN", origin: true },
  { runtime: "DATABASE_PRODUCTION_HOST", github: "DATABASE_PRODUCTION_HOST" },
  { runtime: "NEON_PROJECT_ID", github: "NEON_PROJECT_ID" },
  { runtime: "NEON_PRODUCTION_BRANCH_ID", github: "NEON_PRODUCTION_BRANCH_ID" },
  { runtime: "AUTH_EMAIL_FROM", github: "AUTH_EMAIL_FROM" },
  { runtime: "BLOB_STORE", github: "BLOB_STORE", optionalGithub: true },
  { runtime: "BLOB_BUCKET", github: "BLOB_BUCKET", optionalGithub: true },
];

const FORBIDDEN_RUNTIME_EXACT: readonly string[] = [...FORBIDDEN, "DATABASE_URL_UNPOOLED", "NEON_API_KEY", "DEPLOYMENT_ENVIRONMENT"];
const FORBIDDEN_RUNTIME_PREFIX = ["VAPID_", "STATE_", "VAULT_"] as const;

const manifestEntry = z.object({
  key: z.string().min(1),
  type: z.string().min(1),
  value: z.string().optional(),
  target: z.union([z.string(), z.array(z.string())]).optional(),
});
const manifestSchema = z.union([z.array(manifestEntry), z.object({ envs: z.array(manifestEntry) })]);

export interface RuntimeVariable { type: string; value?: string }
export type RuntimeManifest = Map<string, RuntimeVariable>;

/** Names, types and plain values of the Vercel production variables. Entries for other targets are ignored. */
export function parseRuntimeManifest(json: unknown): RuntimeManifest | undefined {
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) return undefined;
  const entries = Array.isArray(parsed.data) ? parsed.data : parsed.data.envs;
  const manifest: RuntimeManifest = new Map();
  for (const entry of entries) {
    const targets = entry.target === undefined ? ["production"] : [entry.target].flat();
    if (!targets.includes("production")) continue;
    // A value is kept only for a plain variable; anything else is never read.
    manifest.set(entry.key, entry.type === "plain" ? { type: "plain", ...(entry.value === undefined ? {} : { value: entry.value }) } : { type: entry.type });
  }
  return manifest;
}

export function checkRuntimeManifest(manifest: RuntimeManifest | undefined, env: Environment): CheckResult[] {
  if (!manifest) return [result("runtime.manifest", "fail", "CONFIG_MALFORMED", "manifest")];
  const results: CheckResult[] = [];
  const plainValue = (name: string) => manifest.get(name)?.type === "plain" ? manifest.get(name)?.value : undefined;

  const absent = [...RUNTIME_SECRETS, ...RUNTIME_PLAIN, ...RUNTIME_OFF_FLAGS].filter((name) => !manifest.has(name));
  results.push(absent.length ? result("runtime.required", "fail", "CONFIG_MISSING", absent.join(",")) : result("runtime.required", "ok", "CONFIG_OK"));

  const exposed = RUNTIME_SECRETS.filter((name) => manifest.get(name)?.type === "plain");
  results.push(exposed.length ? result("runtime.secrets", "fail", "CONFIG_MALFORMED", exposed.join(",")) : result("runtime.secrets", "ok", "CONFIG_OK"));

  const forbidden = [...manifest.keys()].filter((name) =>
    FORBIDDEN_RUNTIME_EXACT.includes(name) ||
    (FORBIDDEN_RUNTIME_PREFIX.some((prefix) => name.startsWith(prefix)) && !(RUNTIME_OFF_FLAGS as readonly string[]).includes(name)));
  results.push(forbidden.length ? result("runtime.forbidden", "fail", "CONFIG_FORBIDDEN_SET", forbidden.sort().join(",")) : result("runtime.forbidden", "ok", "CONFIG_OK"));

  // A flag that is present must be the plain value "false"; a hidden or unreadable value can not be trusted.
  const enabled = RUNTIME_OFF_FLAGS.filter((name) => manifest.has(name) && plainValue(name)?.trim() !== "false");
  results.push(enabled.length ? result("runtime.flags", "fail", "CONFIG_FLAG_ENABLED", enabled.join(",")) : result("runtime.flags", "ok", "CONFIG_OK"));

  const hidden = RUNTIME_PLAIN.filter((name) => manifest.has(name) && plainValue(name) === undefined);
  const mismatched: string[] = [];
  for (const { runtime, github, origin, optionalGithub } of RUNTIME_EQUALS) {
    const runtimeValue = plainValue(runtime), githubValue = env[github]?.trim();
    if (runtimeValue === undefined || (!githubValue && optionalGithub)) continue;
    if (!githubValue) { mismatched.push(github); continue; }
    const same = origin ? originOf(runtimeValue) !== undefined && originOf(runtimeValue) === originOf(githubValue) : runtimeValue.trim() === githubValue;
    if (!same) mismatched.push(runtime);
  }
  if (plainValue("DATABASE_ENV") !== undefined && plainValue("DATABASE_ENV") !== "production") mismatched.push("DATABASE_ENV");
  results.push(hidden.length ? result("runtime.values", "fail", "CONFIG_MALFORMED", hidden.join(","))
    : mismatched.length ? result("runtime.values", "fail", "CONFIG_VALUE_MISMATCH", mismatched.join(","))
    : result("runtime.values", "ok", "CONFIG_OK"));
  return results;
}
