import { validatePostgresTarget } from "../db/postgres/target";

/** No arbitrary-host override: only the disposable local browser fixture can replace GitHub HTTP. */
export function localStateTestFetch(env: Readonly<Record<string, string | undefined>>): typeof fetch {
  if (env.NODE_ENV !== "development" || env.DATABASE_ENV !== "development" || env.AUTH_TEST_MAILBOX !== "1" || env.VERCEL || env.VERCEL_ENV) {
    throw new Error("Synthetic state transport requires explicit local browser development.");
  }
  const database = validatePostgresTarget({
    connectionString: env.DATABASE_URL ?? "", databaseEnvironment: "development", runtimeEnvironment: "development",
  });
  const endpoint = new URL(env.STATE_SYNC_TEST_GITHUB_URL ?? "");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(database.hostname) || database.pathname !== "/protein_kitchen_e2e" ||
      endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port ||
      endpoint.pathname !== "/" || endpoint.search || endpoint.hash || endpoint.username || endpoint.password ||
      env.STATE_GITHUB_APP_ID !== "123" || env.STATE_GITHUB_INSTALLATION_ID !== "456" || env.STATE_GITHUB_REPOSITORY_ID !== "789" ||
      env.STATE_GITHUB_OWNER !== "synthetic-owner" || env.STATE_GITHUB_REPOSITORY !== "private-state" || env.STATE_GITHUB_BRANCH !== "state/synthetic") {
    throw new Error("Synthetic state transport requires the disposable loopback database and fixed synthetic target.");
  }
  return (input, options) => {
    const url = new URL(String(input));
    if (url.origin !== "https://api.github.com") throw new Error("Synthetic state transport refused a non-GitHub request.");
    return fetch(`${endpoint.origin}${url.pathname}${url.search}`, { ...options, redirect: "error" });
  };
}
