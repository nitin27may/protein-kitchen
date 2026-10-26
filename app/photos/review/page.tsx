import { requirePageMember } from "@/lib/auth/access";
import { isCurator } from "@/lib/auth/curator";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { photoReviewEnabled } from "@/lib/photos/review-flag";
import { ReviewClient, type ReviewSubject } from "@/components/photos/ReviewClient";
import { PageTitle } from "@/components/ui";
import { loadCandidates } from "@/lib/photos/candidates";
import { pageWindow, parseReviewParams } from "@/lib/photos/review-selection";
import { getDecidedReview, getPhotoReview } from "@/lib/server/queries";
import { getData } from "@/lib/server/context";
import { displayName } from "@/lib/schemas";

export const metadata: Metadata = { title: "Review photos" };
export const dynamic = "force-dynamic";
/** Applies to the review actions too: a batch of six downloads can take up to 75 s. */
export const maxDuration = 120;

export default async function ReviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const member = await requirePageMember();
  if (!photoReviewEnabled()) notFound();
  // Library approval is for curators only; everyone else sees what any unknown page shows.
  if (!(await isCurator(member))) notFound();
  const params = parseReviewParams(await searchParams);
  const data = getData();
  const names = {
    recipes: new Map([...data.recipes.values()].filter((r) => r.kind === "recipe").map((r) => [r.slug, r.name] as const)),
    ingredients: new Map([...data.ingredients.values()].map((i) => [i.slug, displayName(i)] as const)),
  };
  const file = loadCandidates(process.cwd());
  const filter = { kind: params.kind, q: params.q, onlyWithoutPhoto: params.missing };
  const all = await getPhotoReview(file, names);
  const waiting = all.reduce((n, i) => n + i.candidates.length, 0);

  if (params.status === "decided") {
    const decided = await getDecidedReview(file, names, filter);
    const window = pageWindow(decided.length, params.page);
    return (
      <div className="pb-10">
        <PageTitle title="Review photos" sub={`${waiting} photos wait for you. Photos you approved and candidates you rejected are listed here.`} />
        <ReviewClient view="decided" params={{ ...params, page: window.page }} decided={decided.slice(window.start, window.end)} items={[]} window={window} totalSubjects={decided.length} matching={0} waiting={waiting} />
      </div>
    );
  }

  const items = await getPhotoReview(file, names, filter);
  const window = pageWindow(items.length, params.page);
  const shown: ReviewSubject[] = items.slice(window.start, window.end).map((i) => ({
    kind: i.kind, slug: i.slug, name: i.name, hasPhoto: i.hasPhoto, photoCount: i.photoCount,
    candidates: i.candidates.map((c) => ({ key: c.key, provider: c.provider, title: c.title, author: c.author, licence: c.licence, licence_url: c.licence_url, source_url: c.source_url, image_url: c.image_url })),
  }));
  const matching = items.reduce((n, i) => n + i.candidates.length, 0);

  return (
    <div className="pb-10">
      <PageTitle title="Review photos" sub={`${waiting} photos from Wikimedia Commons and Openverse wait for you. Nothing shows in the app until you approve it.`} />
      <ReviewClient view="pending" params={{ ...params, page: window.page }} items={shown} decided={[]} window={window} totalSubjects={items.length} matching={matching} waiting={waiting} />
    </div>
  );
}
