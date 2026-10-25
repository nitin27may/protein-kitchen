import type { AnonDraft, AnonProfile, DraftLoad } from "./anon-draft";
import type { AnonLibrary } from "./anon-library";

/**
 * What the draft page shows for each way a stored draft can turn out. Pure, so the wording and the decision to show the
 * plan or the restart screen are tested without a browser.
 */

export type DraftScreen =
  | { kind: "plan"; draft: AnonDraft; warning: string | null }
  | { kind: "message"; title: string; body: string; primary: "restart" | "regenerate" };

const MESSAGES = {
  none: { title: "No plan on this device", body: "Make a plan and it appears here. It stays on this device until you save it to an account." },
  expired: { title: "This plan expired", body: "Plans kept only on this device are removed after 14 days. Make a new one, which takes about a minute." },
  invalid: { title: "This plan could not be read", body: "The saved copy is damaged or incomplete, so it was removed. Make the plan again." },
  "version-mismatch": { title: "This plan is from an older version", body: "The app changed since this plan was made, so it cannot be opened. Make the plan again." },
} as const;

export function draftScreen(load: DraftLoad | { status: "loading" }, profile: AnonProfile | null, library: AnonLibrary | null): DraftScreen | null {
  if (load.status === "loading") return null;
  if (load.status === "none" || load.status === "expired" || load.status === "invalid" || load.status === "version-mismatch") {
    return { kind: "message", ...MESSAGES[load.status], primary: "restart" };
  }
  if (!profile) {
    return { kind: "message", title: "Your profile is missing", body: "The target this plan was made for is no longer on this device. Make the plan again.", primary: "restart" };
  }
  if (!library) return null;
  const missing = load.draft.slots.some((s) => !library.candidates.some((c) => c.slug === s.recipeSlug));
  if (load.status === "library-mismatch") {
    if (missing) {
      return { kind: "message", title: "The recipe library changed", body: "Some meals in this plan are no longer available. Make the plan again to use the current recipes.", primary: "regenerate" };
    }
    return { kind: "plan", draft: load.draft, warning: "The recipe library was updated after you made this plan. Your meals are still available. Make a new plan if you want the latest recipes." };
  }
  if (missing) {
    return { kind: "message", title: "The recipe library changed", body: "Some meals in this plan are no longer available. Make the plan again to use the current recipes.", primary: "regenerate" };
  }
  return { kind: "plan", draft: load.draft, warning: null };
}
