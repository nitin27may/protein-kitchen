"use client";

import { useState } from "react";
import { Sheet } from "@/components/Sheet";
import { Button, Pill } from "@/components/ui";
import { describeStartTime, withAutoplay } from "@/lib/recipes/linkview";
import type { RecipeLinkView } from "@/lib/links/types";

/**
 * Plays a video inside the app, in a sheet, so cook mode keeps its place, timers and screen lock.
 * The player (an iframe to another website) is only created after the person presses play.
 */
export function VideoSheet({ link, onClose }: { link: RecipeLinkView; onClose: () => void }) {
  const [loaded, setLoaded] = useState(false);
  const embed = link.embed;
  const start = describeStartTime(embed?.startSec ?? link.startSec);

  return (
    <Sheet open onClose={onClose} title={link.title}>
      <div className="space-y-3 p-4">
        {embed ? (
          loaded ? (
            <div className="aspect-video w-full overflow-hidden rounded-card bg-black">
              <iframe
                src={withAutoplay(embed.src)}
                title={`Video: ${link.title}`}
                className="size-full border-0"
                allow="encrypted-media; picture-in-picture"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
                sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
              />
            </div>
          ) : (
            <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded-card border border-line bg-surface2 p-4 text-center">
              <Button size="lg" onClick={() => setLoaded(true)} aria-label={`Play video: ${link.title}`}>Play video</Button>
              <p className="text-sm text-muted">{embed.provider === "youtube" ? "YouTube" : "Vimeo"} loads when you press play.{start ? ` Starts at ${start}.` : ""}</p>
            </div>
          )
        ) : (
          <p className="text-sm text-muted">This video cannot play inside the app. Open it on its own website.</p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Pill>Needs internet</Pill>
          {link.source ? <span className="text-sm text-muted">{link.source}</span> : null}
        </div>
        <a href={link.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center justify-center rounded-control border border-line bg-surface px-4 text-sm font-semibold hover:bg-surface2 lg:min-h-9">
          Open on the website
        </a>
      </div>
    </Sheet>
  );
}
