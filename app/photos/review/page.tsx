import { requirePageMember } from "@/lib/auth/access";
import type { Metadata } from "next";
import { ReviewClient } from "@/components/photos/ReviewClient";
import { PageTitle } from "@/components/ui";
import { loadCandidates } from "@/lib/photos/candidates";
import { pendingReview } from "@/lib/server/photo-review";
import type { SubjectKind } from "@/lib/server/photo-review";
import { getData, getDb } from "@/lib/server/context";
import { displayName } from "@/lib/schemas";

export const metadata: Metadata = { title: "Review photos" };
export const dynamic = "force-dynamic";

export default async function ReviewPage({ searchParams }: { searchParams: Promise<{ kind?: string; q?: string; missing?: string }> }) {
  await requirePageMember();
  const sp = await searchParams;
  const kind: SubjectKind | "all" = sp.kind === "recipe" || sp.kind === "ingredient" ? sp.kind : "all";
  const data = getData();
  const names = {
    recipes: new Map([...data.recipes.values()].filter((r) => r.kind === "recipe").map((r) => [r.slug, r.name] as const)),
    ingredients: new Map([...data.ingredients.values()].map((i) => [i.slug, displayName(i)] as const)),
  };
  const file = loadCandidates(process.cwd());
  const all = await pendingReview(await getDb(), file, names);
  const items = await pendingReview(await getDb(), file, names, { kind, q: sp.q, onlyWithoutPhoto: sp.missing === "1" });
  const total = all.reduce((n, i) => n + i.candidates.length, 0);

  return (
    <div className="pb-10">
      <PageTitle title="Review photos" sub={`${total} photos from Wikimedia Commons and Openverse wait for you. Nothing shows in the app until you approve it.`} />
      <ReviewClient items={items} kind={kind} q={sp.q ?? ""} missingOnly={sp.missing === "1"} waiting={all.length} />
    </div>
  );
}
