import { safeHref } from "@/lib/library-photos/model";
import type { PhotoView } from "@/lib/photos/view";

/** The credit line under a hero photo. Your own photos need none; a library or approved-candidate photo shows author and licence with links. */
export function PhotoCredit({ cover }: { cover: PhotoView | undefined }) {
  if (!cover || cover.origin === "upload") return null;
  const source = safeHref(cover.sourceUrl);
  const licence = safeHref(cover.licenceUrl);
  return (
    <p className="-mt-2 text-xs text-muted">
      Photo: {source ? <a href={source} rel="noreferrer" className="underline">{cover.title ?? "source"}</a> : (cover.title ?? "unknown")}
      {cover.author ? `, ${cover.author}` : ""}
      {cover.licence ? <>, {licence ? <a href={licence} rel="noreferrer" className="underline">{cover.licence}</a> : cover.licence}</> : null}
      {" "}(<a href="/credits" className="underline">all credits</a>)
    </p>
  );
}
