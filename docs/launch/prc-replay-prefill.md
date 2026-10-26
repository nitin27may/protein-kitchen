# PR C: replay rate, ban and cooked after signup, and prefill onboarding

## Scope

1. A visitor who rates, hides or marks a recipe as cooked is asked to sign up. After signup the saved action is now finished instead of the visitor being asked to repeat it.
2. The onboarding form is filled from what the visitor entered on this device (name, protein target, calories).

Out of scope: tick-grocery, save-profile and other intents stay "unsupported" and return the person to the page with the existing honest message.

## Dependencies

- `lib/server/pending-intent.ts` (dispatcher), `app/actions.ts` `replayPendingIntent`, `setRecipeFeedback`.
- `lib/auth/signup-gate.ts` `describeReplay`.
- `lib/plan/anon-draft.ts` `loadAnonProfile`, `loadPendingIntent`, `clearAnonProfile`.
- `components/ProfileForm.tsx` (new optional `disabled` prop), `app/onboarding/page.tsx`.

## Permission boundaries

- Ratings, banned and tested flags are human-owned. The replay writes them only through `setRecipeFeedback`, which calls `writePersonalRecipeFeedback` in `lib/human/`. No new table and no direct writes from actions, pages or scripts.
- The replay runs behind `actionDenial()` and the member's household profile, as favourite does today.
- Slug and rating are validated again in the dispatcher with zod (slug pattern, integer 1 to 5) before any handler runs. An unknown slug returns "Recipe not found" and writes nothing.
- Device storage never holds sex, birth date or height, so they are never prefilled.
- No data under `/data` changes.

## Behaviour

| Intent | Server call | Success message |
|---|---|---|
| rate(slug, value) | `setRecipeFeedback(slug, { rating })` | Saved. You rated this recipe N out of 5. |
| ban(slug) | `setRecipeFeedback(slug, { banned: true })` | Saved. This recipe is hidden from your plans. |
| tested(slug) | `setRecipeFeedback(slug, { tested: true })` | Saved. This recipe is marked as cooked. |
| favourite(slug) | unchanged | Saved. This recipe is in your favourites. |

All three are idempotent: replaying twice leaves one feedback row with the same values.

Onboarding prefill (`lib/plan/profile-prefill.ts`, pure):

- name, unless it is the default "You";
- per-kg mode: grams per kg and weight; fixed mode: grams per day;
- calorie target when set.

The client wrapper `components/OnboardingProfileForm.tsx` reads the device profile after hydration, then remounts the form with a key. The form is disabled until that read has finished, so nothing typed is lost. It shows "We filled in what you entered on this device." The device profile is cleared after a successful save only when no pending intent exists; otherwise the replay's `clearAllAnonState` does it.

## Acceptance cases

Unit (Vitest):

- Dispatcher: each new kind routes to its handler; missing handler is unsupported; out-of-range value and bad slug never reach a handler.
- `replayPendingIntent` against a PGlite database: rate, ban, tested write the expected rows, twice is the same; unknown slug fails with "Recipe not found" and writes nothing; a stored rating of 9 is rejected.
- `describeReplay`: one message per kind, failure stays honest, tick-grocery stays unsupported.
- `profilePrefill`: fixed, per-kg, default name, null profile, never fills sex, birth date, height.

Browser (Playwright, `tests/e2e/anonymous-plan.spec.ts`):

- Rate 4, sign up, onboard: back on the recipe with the notice, 4 is selected after a reload.
- Ban and cooked likewise.
- A device profile (name, fixed 90 g) prefills onboarding; the device copy is gone after the save when no action is waiting.
- The unsupported-action test now uses save-profile, because rating is supported.

## Known issues

- When an unsupported intent is pending (for example save-profile), the replay clears only the intent, so the device profile stays on the device after signup.
