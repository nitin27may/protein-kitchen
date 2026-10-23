"use client";

import { LinkChips } from "@/components/links/LinkChips";
import { useLinks } from "@/components/links/LinksProvider";
import { stepLinks } from "@/lib/recipes/linkview";

/** Chips for the links tied to one step of the meal (`partSlug` null) or of a part. `stepNo` is 1-based. */
export function StepLinks({ partSlug, stepNo }: { partSlug: string | null; stepNo: number }) {
  const { links, play } = useLinks();
  return <LinkChips links={stepLinks(links, partSlug, stepNo)} onPlay={play} />;
}
