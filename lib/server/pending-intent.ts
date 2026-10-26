import { z } from "zod";
import type { PendingIntent } from "../plan/anon-draft";

const SlugArg = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/);
const RatingArg = z.number().int().min(1).max(5);
const BAD_INPUT = "That saved action could not be read. Repeat it from the page.";

/** Outcome of finishing the action a visitor started before signing up. */
export type ReplayResult =
  | { ok: true; kind: PendingIntent["kind"]; redirectTo: string; planId?: number; changed?: boolean; libraryChanged?: boolean }
  | { ok: false; kind: PendingIntent["kind"]; error: string; unsupported?: boolean };

type Step = { ok: true } | { ok: false; error: string };

/**
 * The existing server actions, passed in so the dispatcher stays a pure switch. Each one must already enforce
 * membership and write human-owned data only through lib/human/. Missing handlers are reported as unsupported.
 */
export interface IntentHandlers {
  savePlan?: (draft: unknown) => Promise<Step & { planId?: number; changed?: boolean; libraryChanged?: boolean }>;
  favourite?: (slug: string) => Promise<Step>;
  rate?: (slug: string, value: number) => Promise<Step>;
  ban?: (slug: string) => Promise<Step>;
  tested?: (slug: string) => Promise<Step>;
}

const unsupported = (kind: PendingIntent["kind"]): ReplayResult => ({
  ok: false, kind, unsupported: true, error: "That action is not available after signup yet. Repeat it from the page.",
});

const finish = (intent: PendingIntent, done: Step): ReplayResult =>
  done.ok ? { ok: true, kind: intent.kind, redirectTo: intent.returnTo } : { ok: false, kind: intent.kind, error: done.error };

export async function replayIntent(intent: PendingIntent, handlers: IntentHandlers, draft?: unknown): Promise<ReplayResult> {
  switch (intent.kind) {
    case "save-plan": {
      if (!handlers.savePlan) return unsupported(intent.kind);
      if (draft === undefined || draft === null) return { ok: false, kind: intent.kind, error: "The plan draft is no longer on this device. Make the plan again." };
      const saved = await handlers.savePlan(draft);
      if (!saved.ok) return { ok: false, kind: intent.kind, error: saved.error };
      if (saved.planId === undefined) return { ok: false, kind: intent.kind, error: "The plan could not be saved." };
      return { ok: true, kind: intent.kind, redirectTo: `/plan/${saved.planId}`, planId: saved.planId, changed: saved.changed ?? false, libraryChanged: saved.libraryChanged ?? false };
    }
    case "favourite": {
      if (!handlers.favourite) return unsupported(intent.kind);
      const done = await handlers.favourite(intent.slug);
      return done.ok ? { ok: true, kind: intent.kind, redirectTo: intent.returnTo } : { ok: false, kind: intent.kind, error: done.error };
    }
    case "rate": {
      if (!handlers.rate) return unsupported(intent.kind);
      const slug = SlugArg.safeParse(intent.slug);
      const value = RatingArg.safeParse(intent.value);
      if (!slug.success || !value.success) return { ok: false, kind: intent.kind, error: BAD_INPUT };
      return finish(intent, await handlers.rate(slug.data, value.data));
    }
    case "ban": {
      if (!handlers.ban) return unsupported(intent.kind);
      const slug = SlugArg.safeParse(intent.slug);
      if (!slug.success) return { ok: false, kind: intent.kind, error: BAD_INPUT };
      return finish(intent, await handlers.ban(slug.data));
    }
    case "tested": {
      if (!handlers.tested) return unsupported(intent.kind);
      const slug = SlugArg.safeParse(intent.slug);
      if (!slug.success) return { ok: false, kind: intent.kind, error: BAD_INPUT };
      return finish(intent, await handlers.tested(slug.data));
    }
    case "tick-grocery":
    case "save-profile":
    case "other":
      return unsupported(intent.kind);
    default: {
      const never: never = intent;
      return never;
    }
  }
}
