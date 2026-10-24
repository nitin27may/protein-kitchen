import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { PostgresTarget } from "../db/postgres/target";
import { validatePostgresTarget } from "../db/postgres/target";

export class BackupError extends Error {
  constructor(readonly code: "dump-failed" | "encryption-failed" | "write-failed" | "photos-changed" | "backup-failed" | "cleanup-failed", originalCode?: string) {
    super(`Encrypted recovery backup failed (${code}${originalCode ? ` after ${originalCode}` : ""}). No completed backup was reported. Check tooling, source and output permissions, then retry.`);
  }
}

export function assertAgeRecipient(recipient: string) {
  if (!/^age1[02-9ac-hj-np-z]{58}$/.test(recipient)) {
    throw new Error("Supply one classic age public recipient (age-keygen default), never a private identity, plugin or passphrase.");
  }
}

function tool(command: string, args: string[], code: "dump-failed" | "encryption-failed", env?: NodeJS.ProcessEnv) {
  const child = spawn(command, args, {
    env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, timeout: 300_000,
  });
  // Database/tool stderr may contain credentials or personal values; never include it in errors/logs.
  child.stderr.resume();
  const finished = new Promise<void>((resolve, reject) => {
    child.once("error", () => reject(new BackupError(code)));
    child.once("close", (status) => status === 0 ? resolve() : reject(new BackupError(code)));
  });
  return { child, finished };
}
export type DumpSource = { stream: Readable; finished: Promise<void>; abort(): void };

/** libpq receives a single validated target via an isolated environment, never a URL in argv. */
export function postgresEnvironment(target: PostgresTarget): NodeJS.ProcessEnv {
  const url = validatePostgresTarget(target);
  if (!["development", "test"].includes(target.databaseEnvironment) || url.hostname.split(".")[0]?.endsWith("-pooler")) {
    throw new Error("Encrypted backup currently requires a direct development/test target.");
  }
  if ([...url.searchParams.keys()].some((key) => !["sslmode", "channel_binding"].includes(key))) {
    throw new Error("Encrypted backup refuses unsupported libpq connection parameters.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return {
    PATH: process.env.PATH, LANG: "C", NODE_ENV: process.env.NODE_ENV, PGHOST: url.hostname.replace(/^\[|\]$/g, ""),
    PGPORT: url.port || "5432", PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
    PGSSLMODE: url.searchParams.get("sslmode") ?? "disable",
    PGSSLROOTCERT: local ? undefined : "system", PGCHANNELBINDING: url.searchParams.get("channel_binding") ?? "prefer",
    PGCONNECT_TIMEOUT: "10", PGPASSFILE: "/dev/null", PGSERVICEFILE: "/dev/null", PGAPPNAME: "protein-kitchen-backup",
  };
}

export function postgresDump(target: PostgresTarget, binary = "pg_dump"): DumpSource {
  const running = tool(binary, [
    "--format=custom", "--no-owner", "--no-privileges", "--no-password",
    "--exclude-table-data=public.state_sync_jobs", "--exclude-table-data=public.state_sync_requests",
  ], "dump-failed", postgresEnvironment(target));
  running.child.stdin.end();
  return { stream: running.child.stdout, finished: running.finished, abort: () => { running.child.kill("SIGTERM"); } };
}

function meter() {
  const hash = createHash("sha256"); let size = 0;
  return {
    stream: new Transform({ transform(chunk: Buffer, _encoding, done) { size += chunk.byteLength; hash.update(chunk); done(null, chunk); } }),
    receipt: () => ({ sha256: hash.digest("hex"), size }),
  };
}

export async function encryptBackupFile(
  input: DumpSource | Uint8Array, file: string, recipient: string, binary = "age",
) {
  const source: DumpSource = input instanceof Uint8Array
    ? { stream: Readable.from([input]), finished: Promise.resolve(), abort() {} } : input;
  let encryptor: ReturnType<typeof tool>;
  try {
    assertAgeRecipient(recipient);
    encryptor = tool(binary, ["--encrypt", "--recipient", recipient], "encryption-failed", {
      PATH: process.env.PATH, LANG: "C", NODE_ENV: process.env.NODE_ENV,
    });
  } catch {
    source.abort(); source.stream.destroy();
    await source.finished.catch(() => {});
    throw new BackupError("encryption-failed");
  }
  const plaintext = meter(), ciphertext = meter();
  const tasks = [
    source.finished, encryptor.finished,
    pipeline(source.stream, plaintext.stream, encryptor.child.stdin),
    pipeline(encryptor.child.stdout, ciphertext.stream, createWriteStream(file, { flags: "wx", mode: 0o600, flush: true })),
  ];
  try {
    await Promise.all(tasks);
    return { plaintext: plaintext.receipt(), ciphertext: ciphertext.receipt() };
  } catch (error) {
    source.abort(); source.stream.destroy(); encryptor.child.kill("SIGTERM");
    await Promise.allSettled(tasks);
    throw error instanceof BackupError ? error : new BackupError("write-failed");
  }
}
