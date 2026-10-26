import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { revalidatePath } from "next/cache";
import * as s from "../lib/db/schema";
import { actionDenial, requireMember } from "../lib/auth/access";
import { AuthConfigurationError } from "../lib/auth/config";
import { resolveHouseholdAccess } from "../lib/auth/household-access";
import { readSqliteSnapshot } from "../lib/db/sqlite-snapshot";
import { stableJson } from "../lib/human/util";
import { buildLegacyBundle, MAX_BUNDLE_BYTES } from "../lib/legacy/bundle";
import { getDb } from "../lib/server/context";
import { commitLegacyImport, previewLegacyImport } from "../app/settings/legacy-import-actions";
import { openDb, type DbHandle } from "./helpers/db";
import { createLegacySource } from "./helpers/legacy-source";
import { seedLegacyTarget } from "./helpers/legacy-target";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../lib/auth/access", () => ({ actionDenial: vi.fn(), requireMember: vi.fn() }));
vi.mock("../lib/server/context", () => ({ getDb: vi.fn() }));

let h: DbHandle;
let source: ReturnType<typeof createLegacySource>;
let text: string;
let sha: string;
let asUser: (userId: string, role: "owner" | "member") => Promise<void>;

const form = (fields: Record<string, string | Blob | undefined>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) data.set(key, value);
  return data;
};
const file = (content = text) => new File([content], "bundle.json", { type: "application/json" });

beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubEnv("LEGACY_IMPORT_ENABLED", "true");
  source = createLegacySource();
  h = await openDb();
  await seedLegacyTarget(h);
  const bundle = buildLegacyBundle(readSqliteSnapshot(source.file), { withPlans: false, renames: {}, now: () => new Date("2026-10-25T00:00:00.000Z") });
  text = stableJson(bundle);
  sha = bundle.manifest.sha256;
  vi.mocked(actionDenial).mockResolvedValue(null);
  vi.mocked(getDb).mockResolvedValue(h.db);
  asUser = async (userId: string, role: "owner" | "member") => {
    const householdAccess = await resolveHouseholdAccess(h.db, userId, "mine");
    vi.mocked(requireMember).mockResolvedValue({ userId, role, personId: householdAccess.personId!, householdAccess });
  };
  await asUser("owner", "owner");
});
afterEach(() => { source.close(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("legacy import actions", () => {
  it("deny before reading the file or the database when the caller is not an owner", async () => {
    const denied = { ok: false as const, error: "Only a household owner can do that." };
    vi.mocked(actionDenial).mockResolvedValue(denied);
    expect(await previewLegacyImport(form({ bundle: file() }))).toEqual(denied);
    expect(await commitLegacyImport(form({ bundle: file(), confirm_sha256: sha }))).toEqual(denied);
    expect(actionDenial).toHaveBeenCalledWith("owner");
    expect(getDb).not.toHaveBeenCalled();
  });

  it("refuse when the flag is off, before touching the database", async () => {
    vi.stubEnv("LEGACY_IMPORT_ENABLED", "false");
    expect(await previewLegacyImport(form({ bundle: file() }))).toEqual({ ok: false, error: "The legacy import is not enabled on this instance." });
    expect(getDb).not.toHaveBeenCalled();
  });

  it("validate the upload: present, non-empty, under the size limit", async () => {
    expect(await previewLegacyImport(form({}))).toMatchObject({ ok: false, error: expect.stringContaining("Choose the bundle file") });
    expect(await previewLegacyImport(form({ bundle: "just text" }))).toMatchObject({ ok: false });
    expect(await previewLegacyImport(form({ bundle: file("") }))).toMatchObject({ ok: false });
    expect(await previewLegacyImport(form({ bundle: file("x".repeat(MAX_BUNDLE_BYTES + 1)) }))).toMatchObject({ ok: false, error: expect.stringContaining("too large") });
    expect(await previewLegacyImport(form({ bundle: file("{}") }))).toMatchObject({ ok: false, error: expect.stringContaining("not a legacy bundle") });
  });

  it("preview reports counts and people and writes nothing", async () => {
    const result = await previewLegacyImport(form({ bundle: file() }));
    expect(result).toMatchObject({ ok: true, sha256: sha, withPlans: false, report: { dryRun: true, imported: { people: 2 } } });
    if (result.ok) expect(result.people.map((p) => p.name).sort()).toEqual(["Second synthetic cook", "Synthetic import fixture"]);
    expect((await h.db.select().from(s.people)).filter((p) => p.householdId === "mine")).toHaveLength(2);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("commit needs the checksum of the file that was checked, then imports once and refreshes the layout", async () => {
    expect(await commitLegacyImport(form({ bundle: file() }))).toEqual({ ok: false, error: "This is not the file you checked. Check it again before importing." });
    expect(await commitLegacyImport(form({ bundle: file(), confirm_sha256: "0".repeat(64) }))).toMatchObject({ ok: false });
    const link = (await previewLegacyImport(form({ bundle: file() })));
    const key = link.ok ? link.people.find((p) => p.name === "Synthetic import fixture")!.key : "";
    const done = await commitLegacyImport(form({ bundle: file(), confirm_sha256: sha, link_person: key }));
    expect(done).toMatchObject({ ok: true, report: { dryRun: false, linkedPerson: true, removedOnboardingProfile: true } });
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    // The linked profile changed this account's access; the next request resolves it afresh.
    await asUser("owner", "owner");
    expect(await commitLegacyImport(form({ bundle: file(), confirm_sha256: sha }))).toMatchObject({ ok: false, error: expect.stringContaining("already been imported") });
  });

  it("say so when a member's stale ownership or a plain member reaches the service", async () => {
    await asUser("member", "member");
    expect(await previewLegacyImport(form({ bundle: file() }))).toEqual({ ok: false, error: "Only a household owner can import the old data." });
  });

  it("report missing authentication configuration and hide driver errors", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(requireMember).mockRejectedValueOnce(new AuthConfigurationError("missing"));
    expect(await previewLegacyImport(form({ bundle: file() }))).toEqual({ ok: false, error: "Authentication is not configured on this instance." });
    vi.mocked(getDb).mockRejectedValueOnce(new Error("synthetic secret row value"));
    const result = await previewLegacyImport(form({ bundle: file() }));
    expect(result).toEqual({ ok: false, error: "The import could not complete and nothing was changed. Check the bundle and try again." });
    expect(JSON.stringify(errors.mock.calls)).not.toContain("synthetic secret row value");
  });
});
