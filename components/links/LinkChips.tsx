"use client";

import type { OwnedLink } from "@/lib/recipes/linkview";

const chip = "inline-flex min-h-11 max-w-full items-center gap-1 rounded-full border border-primary/40 bg-primarysoft px-3 text-sm font-semibold text-primary hover:bg-surface2 lg:min-h-8";

/** Small chips for the links tied to one step. A video that can play opens `onPlay`; anything else opens its website. */
export function LinkChips({ links, onPlay }: { links: OwnedLink[]; onPlay: (link: OwnedLink) => void }) {
  if (links.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-2" aria-label="Links for this step">
      {links.map((l) => (
        <li key={l.id} className="max-w-full">
          {l.embed ? (
            <button type="button" className={chip} onClick={() => onPlay(l)} aria-label={`Play video: ${l.title}`}>
              <span className="truncate">Video: {l.title}</span>
            </button>
          ) : (
            <a className={chip} href={l.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${l.title} on its website (new tab)`}>
              <span className="truncate">{l.kind === "video" ? "Video" : l.kind === "article" ? "Article" : "Recipe"}: {l.title}</span>
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}
