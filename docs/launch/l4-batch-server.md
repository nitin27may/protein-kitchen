# L4: batch server side of library photo review

Stage record required by CLAUDE.md. Server side only: no UI rewrite (L5), no read path (L3).

## Scope
- `app/photos/review/actions.ts`: `listPendingKeys`, `approveLibraryBatch` (max 6 distinct items), `rejectLibraryBatch` (max 200, one transaction, no network), `removeLibraryPhoto`, `setLibraryCover`, `undoLibraryRejection`. Every action starts with `const denied = await curatorDenial();`, then validates with zod, then works. The client sends only `{kind, slug, key}`; URL, licence and credit come from `data/photo-candidates.json`.
- `lib/server/library-review.ts`: `approveBatch` (pool of 3, 40 s per item, 75 s batch budget, no new item after 60 s, untried or timed-out items return `not-attempted`), `pendingLibraryReview`, `listPendingKeys`, rate cap per person from `library_photo_decisions` (300 approvals per rolling hour, 1000 per day, refused before any network call).
- Licence recheck: Commons titles in one `api.php` call, Openverse one call per id, fixed hosts. Download: allowlist, https only, manual redirects rechecked, 8 MB streaming cap, `image/*` content type, User-Agent with the origin from `PRODUCTION_ORIGIN` or `BETTER_AUTH_URL`, `AbortSignal` support (`lib/photos/remote.ts`).
- Old household `approvePhotoCandidate` / `rejectPhotoCandidate` removed from `app/actions.ts` (exported actions there: 35 to 33). `lib/server/photo-review.ts` now holds only the shared types. `getPhotoReview` reads library decisions and library photos.
- `ReviewClient` uses a minimal adapter over the new actions; approve-all runs in chunks of 6.
- `lib/library-photos/tags.ts`: `LIBRARY_PHOTOS_TAG = "library-photos"`; `updateTag` after approvals, removals and cover changes, plus `revalidatePath("/photos/review")`.

## Route time limit
A `"use server"` file may only export async functions, so `export const maxDuration = 120` sits in `app/photos/review/page.tsx`, the route the actions run under.

## Test seam
`PHOTO_REMOTE_TEST_DIR` (`lib/photos/remote-seam.ts`) serves `tests/fixtures/photos/` (`images/<name>`, `licences.json`) instead of the network. Honoured only when VERCEL is unset, NODE_ENV is not production, DATABASE_ENV is development or test, and the database is loopback `protein_kitchen_e2e` (or Vitest with no DATABASE_URL); anything else throws. Already forbidden in production by `check-production.ts`. The allowlist still runs before the fixture fetch.

## Permission boundaries
Writers: `lib/human/library-photos.ts` only. No file under `scripts/` imports the actions, `library-review`, the seam or the tags (static test). Tests never call Wikimedia or Openverse.

## Acceptance
Offline tests: `library-review`, `library-review-actions`, `photo-remote`, `photo-remote-seam`, plus the extended access inventory and writers tests. Concurrency never above 3, per-item and batch timeouts, partial failures, batched Commons call, changed licence, disallowed redirect, oversize stream, wrong content type, duplicates, subject-full, rate caps, idempotent re-run.

## Known gaps
- No Playwright spec: calling the actions needs the L5 UI and a test route is not allowed. Covered with PGlite tests instead.
- A timed-out item may have downloaded bytes but wrote nothing; it is safe to resend.
