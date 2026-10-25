import {
  clearAllAnonState, clearPendingIntent, loadAnonDraft, loadPendingIntent, mirrorForSignup, savePendingIntent,
  type AnonStores, type PendingIntent, type PendingIntentInput,
} from "../plan/anon-draft";
import { safeAuthReturn } from "./browser";

/**
 * The client side of the signup gate. A gated control calls `beginSignup` instead of its server action; after signup the
 * replay component calls `readPendingWork` and then `describeReplay`. Pure and browser-safe: stores are passed in. This is
 * a convenience only. Every server action still checks the session itself.
 */

type Distribute<T> = T extends unknown ? Omit<T, "createdAt" | "returnTo"> : never;
/** What a caller names: the kind and its fields. The return address is added separately. */
export type GateIntent = Distribute<PendingIntentInput>;

export interface GateRequest {
  intent: GateIntent;
  /** Where to send the person after signup. Defaults to the current page. */
  returnTo: string;
}

/** Saves the intent and mirrors the draft, profile and intent so an email link opened in a new tab can find them. */
export function beginSignup(stores: AnonStores, request: GateRequest, now: Date): { saved: boolean; intent: PendingIntentInput } {
  const intent = { ...request.intent, returnTo: safeAuthReturn(request.returnTo) } as PendingIntentInput;
  let saved = false;
  try { saved = savePendingIntent(stores, intent, now); } catch { saved = false; }
  mirrorForSignup(stores, now);
  return { saved, intent };
}

/** Readable name of what the person was doing, for the message after signup. */
export function intentLabel(intent: Pick<PendingIntent, "kind"> & { action?: string }): string {
  switch (intent.kind) {
    case "save-plan": return "saving the plan";
    case "favourite": return "adding the favourite";
    case "rate": return "rating the recipe";
    case "ban": return "hiding the recipe";
    case "tested": return "marking the recipe as cooked";
    case "tick-grocery": return "ticking the grocery item";
    case "save-profile": return "saving your profile";
    case "other": return intent.action ?? "that action";
  }
}

export interface PendingWork {
  intent: PendingIntent;
  /** The draft to hand to the server for a save-plan intent, or null when none is usable. */
  draft: unknown | null;
  /** Set when a save-plan intent has no usable draft, with the reason in words. */
  draftProblem: string | null;
}

const DRAFT_PROBLEM = {
  none: "The plan draft is no longer on this device. Make the plan again.",
  expired: "Your plan draft expired. Make the plan again.",
  invalid: "The plan draft could not be read. Make the plan again.",
  "version-mismatch": "The plan draft was made with an older version of the app. Make the plan again.",
} as const;

export function readPendingWork(stores: AnonStores, now: Date): PendingWork | null {
  const intent = loadPendingIntent(stores, now);
  if (!intent) return null;
  if (intent.kind !== "save-plan") return { intent, draft: null, draftProblem: null };
  const loaded = loadAnonDraft(stores, { now });
  if (loaded.status === "ok") return { intent, draft: loaded.draft, draftProblem: null };
  return { intent, draft: null, draftProblem: loaded.status === "library-mismatch" ? null : DRAFT_PROBLEM[loaded.status] };
}

export type ReplayWire =
  | { ok: true; replay: { ok: true; kind: PendingIntent["kind"]; redirectTo: string; planId?: number; changed?: boolean; libraryChanged?: boolean } | { ok: false; kind: PendingIntent["kind"]; error: string; unsupported?: boolean } }
  | { ok: false; error: string };

export interface ReplayOutcome {
  /** done: the action happened. unsupported: signed up, but the person repeats it. failed: it could not be done. */
  status: "done" | "unsupported" | "failed";
  redirectTo: string;
  message: string;
  /** What to remove from the device afterwards. */
  clear: "all" | "intent";
}

export function describeReplay(intent: PendingIntent, wire: ReplayWire): ReplayOutcome {
  const back = intent.returnTo;
  if (!wire.ok) return { status: "failed", redirectTo: back, message: wire.error, clear: "intent" };
  const r = wire.replay;
  if (r.ok) {
    if (r.kind === "save-plan") {
      const note = r.libraryChanged || r.changed ? " Some meals were adjusted to your kitchen's recipes and feedback." : "";
      return { status: "done", redirectTo: r.redirectTo, message: `Plan saved to your kitchen.${note}`, clear: "all" };
    }
    return { status: "done", redirectTo: r.redirectTo, message: "Saved. Your favourite is in your account.", clear: "all" };
  }
  if (r.unsupported) {
    return { status: "unsupported", redirectTo: back, message: `You are signed up. Repeat ${intentLabel(intent)} from this page.`, clear: "intent" };
  }
  return { status: "failed", redirectTo: back, message: r.error, clear: "intent" };
}

/** Applies the clean-up an outcome asks for. A failed plan save keeps the draft so the person can try again. */
export function applyOutcome(stores: AnonStores, outcome: ReplayOutcome): void {
  if (outcome.clear === "all") {
    clearAllAnonState(stores);
    try { stores.session?.removeItem(ANON_TICKS_KEY); } catch { /* nothing to remove */ }
  } else clearPendingIntent(stores);
}

/** Groceries ticked on the device while signed out. Removed with the rest of the device copy after a successful import. */
export const ANON_TICKS_KEY = "pk-anon-ticks";
