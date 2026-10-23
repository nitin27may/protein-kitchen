import type { PartMode, PartModes } from "./mode";

/** Decides the mode for a part (component slug). Returning undefined means "make", the default. */
export type PartResolver = (componentSlug: string) => PartMode | undefined;

/** A resolver over a plan's saved part modes, or undefined when there are none (every part is made). */
export function resolverFor(modes: PartModes | undefined): PartResolver | undefined {
  if (!modes || Object.keys(modes).length === 0) return undefined;
  return (slug) => modes[slug];
}

/**
 * Whether a part must be cooked for this plan. "Have" needs no cooking. "Buy" needs none either, but only when the
 * recipe names a ready-made alternative (`alt_ingredient`); without one the part falls back to being made, the same
 * rule the grocery list uses.
 */
export function partIsMade(mode: PartMode | undefined, hasBuyAlternative: boolean): boolean {
  if (mode === "have") return false;
  if (mode === "buy") return !hasBuyAlternative;
  return true;
}
