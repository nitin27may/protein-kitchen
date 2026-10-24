import { and, eq, isNull } from "drizzle-orm";
import type { PhotoWriteScope } from "../human/photos";
import type { BlobStore } from "../blob/types";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { approveCandidate, rejectCandidate } from "../human";
import type { Candidate, CandidateFile } from "../photos/candidates";
import { PhotoError } from "../photos/process";
import { downloadImage, recheckLicence, RemoteError } from "../photos/remote";

export type SubjectKind = "recipe" | "ingredient";

export interface ReviewItem {
  kind: SubjectKind;
  slug: string;
  name: string;
  /** Candidates not yet approved or rejected for this subject. */
  candidates: Candidate[];
  /** True when the subject already has a photo of its own, so candidates are optional extras. */
  hasPhoto: boolean;
}

export interface ReviewFilter {
  kind?: SubjectKind | "all";
  q?: string;
  /** Hide subjects that already have a photo. */
  onlyWithoutPhoto?: boolean;
}

const decisionKey = (kind: string, slug: string, key: string) => `${kind}\u0000${slug}\u0000${key}`;

/** Candidates still waiting for a decision, grouped by recipe or ingredient. Names come from the library. */
export async function pendingReview(db: Db, file: CandidateFile, names: { recipes: ReadonlyMap<string, string>; ingredients: ReadonlyMap<string, string> }, filter: ReviewFilter = {}, householdId?: string): Promise<ReviewItem[]> {
  const decided = new Set((await db.select().from(s.photoDecisions).where(householdId === undefined ? isNull(s.photoDecisions.householdId) : eq(s.photoDecisions.householdId, householdId))).map((d) => decisionKey(d.subjectKind, d.subjectSlug, d.candidateKey)));
  const photoRows = await db.select({ recipeId: s.photos.recipeId, ingredientSlug: s.photos.ingredientSlug }).from(s.photos).where(householdId === undefined ? isNull(s.photos.householdId) : eq(s.photos.householdId, householdId));
  const recipeIds = new Map((await db.select({ id: s.recipes.id, slug: s.recipes.slug }).from(s.recipes)).map((r) => [r.id, r.slug]));
  const withPhoto = new Set(photoRows.map((p) => (p.recipeId !== null ? `recipe:${recipeIds.get(p.recipeId)}` : `ingredient:${p.ingredientSlug}`)));
  const q = (filter.q ?? "").trim().toLowerCase();

  const items: ReviewItem[] = [];
  for (const [kind, subjectKind, nameMap] of [["recipes", "recipe", names.recipes], ["ingredients", "ingredient", names.ingredients]] as const) {
    if (filter.kind && filter.kind !== "all" && filter.kind !== subjectKind) continue;
    for (const [slug, list] of Object.entries(file[kind])) {
      const name = nameMap.get(slug);
      if (!name) continue;
      if (q && !name.toLowerCase().includes(q) && !slug.includes(q)) continue;
      const pending = list.filter((c) => !decided.has(decisionKey(subjectKind, slug, c.key)));
      if (pending.length === 0) continue;
      const hasPhoto = withPhoto.has(`${subjectKind}:${slug}`);
      if (filter.onlyWithoutPhoto && hasPhoto) continue;
      items.push({ kind: subjectKind, slug, name, candidates: pending, hasPhoto });
    }
  }
  return items.sort((a, b) => Number(a.hasPhoto) - Number(b.hasPhoto) || a.name.localeCompare(b.name));
}

function find(file: CandidateFile, kind: SubjectKind, slug: string, key: string): Candidate | undefined {
  return file[kind === "recipe" ? "recipes" : "ingredients"][slug]?.find((c) => c.key === key);
}

type Outcome = { ok: true; recipeSlug: string | null } | { ok: false; error: string };

interface Deps {
  fetchImpl?: typeof fetch;
}

/**
 * Approves one candidate. The client sends only the subject and candidate key: the URL, licence and credit come from
 * data/photo-candidates.json on the server, never from the request. The licence is checked again with the provider, the
 * image is fetched from an allowlisted host, and the bytes go through the same pipeline as an upload.
 */
export async function approveCandidateChecked(db: Db, store: BlobStore, file: CandidateFile, input: PhotoWriteScope & { kind: SubjectKind; slug: string; key: string; personId?: number | null }, deps: Deps = {}): Promise<Outcome> {
  const candidate = find(file, input.kind, input.slug, input.key);
  if (!candidate) return { ok: false, error: "That photo is no longer in the candidate list." };

  let subject: { kind: "recipe"; recipeId: number } | { kind: "ingredient"; slug: string };
  if (input.kind === "recipe") {
    const [r] = await db.select({ id: s.recipes.id }).from(s.recipes).where(and(eq(s.recipes.slug, input.slug)));
    if (!r) return { ok: false, error: "Recipe not found." };
    subject = { kind: "recipe", recipeId: r.id };
  } else {
    subject = { kind: "ingredient", slug: input.slug };
  }

  const licenceProblem = await recheckLicence(candidate, deps.fetchImpl);
  if (licenceProblem) return { ok: false, error: licenceProblem };
  let bytes: Uint8Array;
  try {
    bytes = await downloadImage(candidate.image_url, deps.fetchImpl);
  } catch (e) {
    if (e instanceof RemoteError) return { ok: false, error: e.message };
    throw e;
  }
  try {
    await approveCandidate(db, store, {
      candidateKey: candidate.key,
      provider: candidate.provider,
      subject,
      subjectSlug: input.slug,
      bytes,
      credit: { title: candidate.title, author: candidate.author, licence: candidate.licence, licenceUrl: candidate.licence_url, sourceUrl: candidate.source_url },
      personId: input.personId,
      householdId: input.householdId, commit: input.commit,
    });
  } catch (e) {
    if (e instanceof PhotoError) return { ok: false, error: e.message };
    throw e;
  }
  return { ok: true, recipeSlug: input.kind === "recipe" ? input.slug : null };
}

export async function rejectCandidateChecked(db: Db, file: CandidateFile, input: PhotoWriteScope & { kind: SubjectKind; slug: string; key: string; personId?: number | null }): Promise<Outcome> {
  if (!find(file, input.kind, input.slug, input.key)) return { ok: false, error: "That photo is no longer in the candidate list." };
  await rejectCandidate(db, { ...input, candidateKey: input.key });
  return { ok: true, recipeSlug: null };
}
