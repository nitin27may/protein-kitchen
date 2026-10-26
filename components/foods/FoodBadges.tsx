import { Pill } from "@/components/ui";
import { sourceBadge, type FoodSourceKind } from "@/lib/foods/form";

/** How the food got here, in plain words, plus the flags that change how far its numbers can be trusted. */
export function FoodBadges({ source, estimatedWeight, archived = false }: { source: FoodSourceKind; estimatedWeight: boolean; archived?: boolean }) {
  const badge = sourceBadge(source);
  return (
    <span className="flex flex-wrap gap-1.5">
      <Pill tone={badge.tone}>{badge.text}</Pill>
      {estimatedWeight ? <Pill tone="warn">Estimated weight</Pill> : null}
      {archived ? <Pill tone="info">Archived</Pill> : null}
    </span>
  );
}
