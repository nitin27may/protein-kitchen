import type { PhotoView } from "@/lib/server/photo-index";

/** The credit line under a hero photo. Your own photos need none; an approved candidate shows author and licence with links. */
export function PhotoCredit({ cover }: { cover: PhotoView | undefined }) {
  if (!cover || cover.origin === "upload") return null;
  return (
    <p className="-mt-2 text-xs text-muted">
      Photo: {cover.sourceUrl ? <a href={cover.sourceUrl} rel="noreferrer" className="underline">{cover.title ?? "source"}</a> : (cover.title ?? "unknown")}
      {cover.author ? `, ${cover.author}` : ""}
      {cover.licence ? <>, {cover.licenceUrl ? <a href={cover.licenceUrl} rel="noreferrer" className="underline">{cover.licence}</a> : cover.licence}</> : null}
      {" "}(<a href="/credits" className="underline">all credits</a>)
    </p>
  );
}
