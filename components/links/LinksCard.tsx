"use client";

import { LinkItem } from "@/components/links/LinkItem";
import { useLinks } from "@/components/links/LinksProvider";
import { Button, SectionCard } from "@/components/ui";
import { wholeLinks } from "@/lib/recipes/linkview";

/** "Watch and read": the links for the whole recipe, with add, edit, remove and reorder. */
export function LinksCard() {
  const { links, play, openAdd, openEdit, remove, move, busy, readOnly } = useLinks();
  const list = wholeLinks(links);
  if (readOnly) return null;

  return (
    <SectionCard
      id="links"
      title="Watch and read"
      description="Recipe pages and videos you cook from. They open on their own websites."
      action={<Button variant="secondary" size="sm" onClick={() => openAdd({ scope: "whole" })}>Add a link</Button>}
    >
      {list.length === 0 ? (
        <p className="text-sm text-muted">No links yet. Add a recipe page or video you cook from.</p>
      ) : (
        <ul className="space-y-2">
          {list.map((l, i) => (
            <LinkItem key={l.id} link={l} first={i === 0} last={i === list.length - 1} busy={busy} actions={{ onPlay: play, onEdit: openEdit, onRemove: remove, onMove: move }} />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
