import type { ProfileInitial } from "../../components/ProfileForm";
import type { AnonProfile } from "./anon-draft";

/** The name an anonymous profile gets when the visitor typed none. It is a placeholder, not something they entered. */
const DEFAULT_ANON_NAME = "You";

/**
 * Fills the onboarding form from what a visitor entered on this device. Sex, birth date, height and activity are never in
 * device storage, so they are never filled. Returns `filled: false` when nothing was carried over.
 */
export function profilePrefill(anon: AnonProfile | null, initial: ProfileInitial): { initial: ProfileInitial; filled: boolean } {
  if (!anon) return { initial, filled: false };
  const next: ProfileInitial = { ...initial };
  if (anon.name && anon.name !== DEFAULT_ANON_NAME) next.name = anon.name;
  if (anon.protein.mode === "perKg") {
    next.proteinMode = "per_kg";
    next.proteinValue = anon.protein.gPerKg;
    next.weightKg = anon.protein.weightKg;
  } else {
    next.proteinMode = "fixed";
    next.proteinValue = anon.protein.grams;
  }
  if (anon.kcalTarget !== null) next.kcalTarget = anon.kcalTarget;
  return { initial: next, filled: true };
}
