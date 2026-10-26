"use server";

import { revalidatePath } from "next/cache";
import { actionDenial, requireMember } from "@/lib/auth/access";
import { AuthConfigurationError } from "@/lib/auth/config";
import { HouseholdAccessError } from "@/lib/auth/household";
import { memberHouseholdAccess } from "@/lib/auth/household-access";
import { loadRenames } from "@/lib/db/renames";
import { importLegacyBundle, legacyImportEnabled, LegacyImportError, type LegacyImportReport } from "@/lib/human/legacy-household-import";
import { LegacyBundleError, MAX_BUNDLE_BYTES, parseLegacyBundle } from "@/lib/legacy/bundle";
import { getDb } from "@/lib/server/context";

export type LegacyImportResult =
  | { ok: true; report: LegacyImportReport; sha256: string; withPlans: boolean; people: { key: string; name: string }[] }
  | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** The bundle arrives as one file field. Size is checked before the text is read, and again by the parser. */
async function bundleText(form: FormData): Promise<string | { ok: false; error: string }> {
  const file = form.get("bundle");
  if (!(file instanceof File) || file.size === 0) return fail("Choose the bundle file you built with pnpm legacy:bundle.");
  if (file.size > MAX_BUNDLE_BYTES) return fail("The bundle file is too large. It must be under 4 MB.");
  return file.text();
}

async function run(form: FormData, commit: boolean): Promise<LegacyImportResult> {
  const denied = await actionDenial("owner");
  if (denied) return denied;
  if (!legacyImportEnabled()) return fail("The legacy import is not enabled on this instance.");
  const text = await bundleText(form);
  if (typeof text !== "string") return text;
  try {
    const bundle = parseLegacyBundle(text);
    const confirm = form.get("confirm_sha256");
    // The commit must be the file that was previewed.
    if (commit && confirm !== bundle.manifest.sha256) return fail("This is not the file you checked. Check it again before importing.");
    const link = form.get("link_person");
    const linkPerson = typeof link === "string" && link !== "" ? link : null;
    const db = await getDb();
    const access = await memberHouseholdAccess(db, await requireMember());
    const report = await importLegacyBundle(db, access, text, { commit, linkPerson, renames: loadRenames() });
    if (commit) revalidatePath("/", "layout");
    return { ok: true, report, sha256: bundle.manifest.sha256, withPlans: bundle.with_plans, people: bundle.data.people.map((p) => ({ key: p.key, name: p.name })) };
  } catch (error) {
    if (error instanceof LegacyBundleError || error instanceof LegacyImportError || error instanceof HouseholdAccessError) return fail(error.message);
    if (error instanceof AuthConfigurationError) {
      console.error("Legacy import requires authentication configuration.");
      return fail("Authentication is not configured on this instance.");
    }
    // Driver errors can embed row values; log a code only.
    console.error("Legacy import failed and was rolled back.", { code: "import-failed" });
    return fail("The import could not complete and nothing was changed. Check the bundle and try again.");
  }
}

/** Dry run: every write happens inside the transaction, is counted, and is rolled back. */
export async function previewLegacyImport(form: FormData): Promise<LegacyImportResult> {
  return run(form, false);
}

export async function commitLegacyImport(form: FormData): Promise<LegacyImportResult> {
  return run(form, true);
}
