import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { validatePostgresTarget } from "../db/postgres/target";
import { AuthConfigurationError } from "./config";
import { tokenHash } from "./tokens";
import type { AuthCodeMail } from "./create";

export function testMailPath(email: string, type: AuthCodeMail["type"]) {
  return path.resolve("test-results/auth-mail", `${tokenHash(email.toLowerCase())}-${type}.json`);
}

/** An explicit synthetic-only transport; no OTP endpoint and no production fallback. */
export function localTestCodeSender(env: Readonly<Record<string, string | undefined>>) {
  if (env.AUTH_TEST_MAILBOX !== "1" || env.NODE_ENV !== "development" || env.DATABASE_ENV !== "development" || env.VERCEL) {
    throw new AuthConfigurationError("The synthetic auth mailbox is only available in explicit local development.");
  }
  const url = validatePostgresTarget({
    connectionString: env.DATABASE_URL ?? "", databaseEnvironment: "development", runtimeEnvironment: "development",
  });
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/protein_kitchen_e2e") {
    throw new AuthConfigurationError("The synthetic auth mailbox requires the disposable loopback protein_kitchen_e2e database.");
  }
  return async (mail: AuthCodeMail) => {
    if (!/^[^@\s]+@example\.test$/i.test(mail.email)) throw new Error("The synthetic auth mailbox only accepts example.test recipients.");
    const file = testMailPath(mail.email, mail.type);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(mail), { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
  };
}
