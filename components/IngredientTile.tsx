import type { ComponentType, SVGProps } from "react";
import { BeanIcon, BlockIcon, CapsuleIcon, DropIcon, FlameIcon, FruitIcon, JarIcon, LeafIcon, MilkIcon, NutIcon, RaisinIcon, SackIcon, WheatIcon } from "@/components/icons";
import { aisleLabel } from "@/lib/format";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

/** One icon and tint per aisle: the stand-in for an ingredient that has no approved photo. */
const AISLE_LOOK: Record<string, { icon: Icon; tint: string }> = {
  vegetables: { icon: LeafIcon, tint: "bg-oksoft text-ok" },
  fruit: { icon: FruitIcon, tint: "bg-badsoft text-bad" },
  grains: { icon: WheatIcon, tint: "bg-warnsoft text-warn" },
  flours: { icon: SackIcon, tint: "bg-warnsoft text-warn" },
  legumes: { icon: BeanIcon, tint: "bg-accentsoft text-accent" },
  "soy-protein": { icon: BlockIcon, tint: "bg-accentsoft text-accent" },
  "nuts-seeds": { icon: NutIcon, tint: "bg-warnsoft text-warn" },
  "dried-fruit": { icon: RaisinIcon, tint: "bg-badsoft text-bad" },
  dairy: { icon: MilkIcon, tint: "bg-primarysoft text-primary" },
  oils: { icon: DropIcon, tint: "bg-warnsoft text-warn" },
  fats: { icon: DropIcon, tint: "bg-warnsoft text-warn" },
  spices: { icon: FlameIcon, tint: "bg-badsoft text-bad" },
  supplements: { icon: CapsuleIcon, tint: "bg-surface2 text-muted" },
  pantry: { icon: JarIcon, tint: "bg-surface2 text-muted" },
};

const FALLBACK = { icon: JarIcon, tint: "bg-surface2 text-muted" };

/**
 * Photo stand-in for an ingredient: an aisle-tinted tile with a line icon. `card` fills its parent and adds the name and
 * state; `thumb` is just the icon, for lists where the name sits beside it. Decorative: the name is always shown nearby.
 */
export function IngredientTile({ aisle, name, state, size = "thumb", className = "" }: { aisle: string; name?: string; state?: string; size?: "card" | "thumb"; className?: string }) {
  const look = AISLE_LOOK[aisle] ?? FALLBACK;
  const Icon = look.icon;
  if (size === "thumb") {
    return (
      <span className={`flex items-center justify-center ${look.tint} ${className}`} aria-hidden="true" title={aisleLabel(aisle)}>
        <Icon className="size-1/2" />
      </span>
    );
  }
  return (
    <div className={`flex size-full flex-col items-center justify-center gap-1.5 px-3 text-center ${look.tint} ${className}`} aria-hidden="true">
      <Icon className="size-10" />
      {name ? <span className="line-clamp-2 text-sm font-semibold leading-tight">{name}</span> : null}
      {state && state !== "ready" ? <span className="rounded-full bg-surface/70 px-2 py-0.5 text-xs font-medium">{state}</span> : null}
    </div>
  );
}
