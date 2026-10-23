"use client";

import { useState } from "react";
import { ChevronDownIcon } from "@/components/icons";
import { Button, Pill } from "@/components/ui";
import { LINK_KIND_LABEL } from "@/lib/links/types";
import { describeStartTime, describeTarget } from "@/lib/recipes/linkview";
import type { OwnedLink } from "@/lib/recipes/linkview";

const anchorClass = "inline-flex min-h-11 items-center justify-center rounded-control border border-line bg-surface px-3 text-sm font-semibold hover:bg-surface2 lg:min-h-9";
const iconButton = "size-11 px-0 lg:size-9";

export interface LinkItemActions {
  onPlay: (link: OwnedLink) => void;
  onEdit?: (link: OwnedLink) => void;
  onRemove?: (link: OwnedLink) => void;
  onMove?: (link: OwnedLink, direction: "up" | "down") => void;
}

/**
 * One saved link: its kind, title and source, a "Play here" button for videos that can play in the app, and an
 * "Open" link for the website. When editing is allowed it also has Edit, Remove (confirmed here, in the page) and
 * move up and down.
 */
export function LinkItem({ link, actions, compact = false, first = false, last = false, partName, busy = false }: { link: OwnedLink; actions: LinkItemActions; compact?: boolean; first?: boolean; last?: boolean; partName?: (slug: string) => string | null; busy?: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const start = describeStartTime(link.embed?.startSec ?? link.startSec);
  const target = partName ? describeTarget(link, partName) : null;
  const editable = !!actions.onEdit;
  const details = [link.source, start ? `starts at ${start}` : null, target].filter(Boolean).join(" · ");

  return (
    <li className={`rounded-control border border-line bg-surface ${compact ? "p-2.5" : "p-3"}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="break-words font-semibold leading-snug">{link.title}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
            <Pill tone={link.kind === "video" ? "info" : "ok"}>{LINK_KIND_LABEL[link.kind]}</Pill>
            {details ? <span>{details}</span> : null}
          </p>
        </div>
        {editable && actions.onMove ? (
          <div className="flex shrink-0 flex-col lg:flex-row">
            <Button variant="ghost" size="sm" className={iconButton} aria-label={`Move up: ${link.title}`} disabled={first || busy} onClick={() => actions.onMove?.(link, "up")}><ChevronDownIcon className="size-5 rotate-180" /></Button>
            <Button variant="ghost" size="sm" className={iconButton} aria-label={`Move down: ${link.title}`} disabled={last || busy} onClick={() => actions.onMove?.(link, "down")}><ChevronDownIcon className="size-5" /></Button>
          </div>
        ) : null}
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        {link.embed ? <Button size="sm" onClick={() => actions.onPlay(link)} aria-label={`Play video: ${link.title}`}>Play here</Button> : null}
        <a href={link.url} target="_blank" rel="noopener noreferrer" className={anchorClass} aria-label={`Open ${link.title} on its website (new tab)`}>Open</a>
        {editable ? <Button variant="ghost" size="sm" onClick={() => actions.onEdit?.(link)} aria-label={`Edit link: ${link.title}`}>Edit</Button> : null}
        {editable && !confirming ? <Button variant="ghost" size="sm" onClick={() => setConfirming(true)} aria-label={`Remove link: ${link.title}`}>Remove</Button> : null}
      </div>

      {confirming ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-control bg-badsoft px-3 py-2" role="group" aria-label={`Confirm removing ${link.title}`}>
          <p className="text-sm font-semibold text-bad">Remove this link?</p>
          <Button variant="danger" size="sm" disabled={busy} onClick={() => { setConfirming(false); actions.onRemove?.(link); }}>Yes, remove</Button>
          <Button variant="secondary" size="sm" onClick={() => setConfirming(false)}>Keep</Button>
        </div>
      ) : null}
    </li>
  );
}
