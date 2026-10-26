import type { DataSet } from "@/lib/data/load";
import type { Db } from "@/lib/db/client";
import { libraryStatus, type LibraryStatus } from "@/lib/db/library-version";

export interface HealthBody {
  ok: boolean;
  release: string;
  database: "ok" | "unavailable";
  library: LibraryStatus;
}

export interface HealthDeps {
  release: string | undefined;
  db: () => Promise<Db>;
  data: () => DataSet;
}

const SHA = /^[0-9a-f]{7,64}$/;

/**
 * Fixed-shape probe result. Every failure collapses to a constant: no error text, host or value is ever returned.
 * An unreachable database reports library "stale" because the version cannot be confirmed.
 */
export async function healthReport(deps: HealthDeps): Promise<{ status: 200 | 503; body: HealthBody }> {
  const release = deps.release && SHA.test(deps.release) ? deps.release : "unknown";
  let database: HealthBody["database"] = "unavailable";
  let library: LibraryStatus = "stale";
  try {
    library = await libraryStatus(await deps.db(), deps.data());
    database = "ok";
  } catch {
    // Deliberately swallowed; the response carries only the fixed states.
  }
  const ok = database === "ok" && library !== "stale";
  return { status: ok ? 200 : 503, body: { ok, release, database, library } };
}
