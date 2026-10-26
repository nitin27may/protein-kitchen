# WP6: photo candidate review off at launch

Part of the launch stage in `docs/plan-v3-publish-and-protect.md` (decision 11, "Features OFF at launch"). Stage record required by CLAUDE.md.

## Scope

Photo candidate review (`/photos/review`, approve and reject) is switched off in production at launch. Photos are reviewed after launch. The final library-level approval design is still open, and any per-household approval saved now would have to be migrated later.

Stays on: own photo uploads (per household, `BLOB_STORE=neon`) and `/credits`.

### Flag

`PHOTO_REVIEW_ENABLED`, read by `photoReviewEnabled()` in `lib/photos/review-flag.ts`.

| Value | Result |
| --- | --- |
| unset or blank, `VERCEL_ENV=production` | off |
| unset or blank, anything else | on (local dev, e2e, preview) |
| `true` / `false` (case-insensitive) | explicit |
| any other value | off (fails closed) |

### When off

- `/photos/review` checks membership (the access inventory test requires it first), then calls `notFound()` before any data access. Signed-out visitors still go to sign-in; members get 404.
- `approvePhotoCandidate` and `rejectPhotoCandidate` return `{ ok: false, error: "Photo review is not available yet." }` after the sign-in check and before any database, blob or candidate-file access. Nothing is written. No new writers: the existing `lib/human/` path is untouched.
- The sidebar "Review photos" link, the Settings Photos card link and the "Review more photos" link on `/credits` are not rendered. Settings shows a plain count of photos kept.

### Deployment check

`PHOTO_REVIEW_ENABLED` is added to `FLAGS` in `lib/deployment/check-production.ts`. Like the other launch flags, `pnpm db:check:production` fails with `CONFIG_FLAG_ENABLED` if it is set to anything but `false`. Unset passes (production default is off). `.env.example` lists the name only.

## Dependencies and permission boundaries

No schema change, no migration, no new env credentials. No remote service is contacted by the tests: Vitest uses mocks, Playwright uses the throwaway loopback `protein_kitchen_e2e` database.

## Acceptance cases

1. Flag parsing and defaults (`tests/photo-review-gate.test.ts`).
2. Both actions refuse with the flag off and do not touch `getDb` or `getData`.
3. The review page throws `notFound` with the flag off.
4. The sidebar omits the review link when off and shows it when on; the credits link stays.
5. `check-production` rejects `PHOTO_REVIEW_ENABLED=true` and accepts `false`.
6. Browser (`tests/e2e/photo-gate.spec.ts`, retained): with the server started with `PHOTO_REVIEW_ENABLED=false`, `/photos/review` is 404, no link to it appears on Settings or Credits, and `/credits` renders.
   Run: `PHOTO_REVIEW_ENABLED=false pnpm test:e2e tests/e2e/photo-gate.spec.ts`.
7. Existing review specs run with the flag unset (on). Two of them skip themselves if the flag is forced off.

## Gotchas

- The browser server reads the flag at start, so the gate spec needs its own server run; it skips itself otherwise.
- Enabling review after launch is a deliberate change: set `PHOTO_REVIEW_ENABLED=true` in Vercel and remove it from the launch flag list in the same change.
