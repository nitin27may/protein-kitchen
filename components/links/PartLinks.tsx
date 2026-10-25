"use client";

import { LinkItem } from "@/components/links/LinkItem";
import { useLinks } from "@/components/links/LinksProvider";
import { Button } from "@/components/ui";
import { partLinks } from "@/lib/recipes/linkview";

/**
 * The saved links for one part of a meal, inside its card. Links saved on the part's own page show here too, so a
 * video added for hummus is visible in every meal that uses hummus.
 */
export function PartLinks({ partSlug, partName }: { partSlug: string; partName: string }) {
  const { links, play, openAdd, openEdit, remove, move, busy, readOnly } = useLinks();
  const list = partLinks(links, partSlug);
  if (readOnly) return null;

  return (
    <div data-slot="part-links">
      {list.length ? (
        <div className="space-y-2">
          <p className="text-sm font-semibold">Watch and read</p>
          <ul className="space-y-2">
            {list.map((l, i) => (
              <LinkItem key={l.id} link={l} compact first={i === 0} last={i === list.length - 1} busy={busy} actions={{ onPlay: play, onEdit: openEdit, onRemove: remove, onMove: move }} />
            ))}
          </ul>
        </div>
      ) : null}
      <Button variant="ghost" size="sm" className={list.length ? "mt-1" : ""} onClick={() => openAdd({ scope: "part", partSlug })} aria-label={`Add a link for ${partName}`}>Add a link for this part</Button>
    </div>
  );
}
