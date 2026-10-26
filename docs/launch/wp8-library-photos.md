# WP8 / L1: library photos, data layer

Stage record required by CLAUDE.md. Part of the launch work in `docs/plan-v3-publish-and-protect.md`; this file holds the detail so that plan is not extended.

## Why

WP6 switched candidate review off because a per-household approval would have to be migrated later. The decision: a photo approval is made once, for the whole library, and shown to everyone. In `photos` and `photo_decisions` a NULL `household_id` means quarantined operator staging, so library approvals get their own tables rather than reusing those rows.

## Scope (L1: data layer only)

No UI, no read-path change, no route, no action, no flag change. Nothing shows a library photo yet.

- Migration `0022_library_photos.sql` (expand only, no `-- contract-ok`): `library_photos` and `library_photo_decisions`, no household column.
- Blob keys `library/<uid>/master.webp` and `library/<uid>/thumb.webp` (`libraryPhotoKeys`). Library masters are 1280 px, thumbnails 640 px (`processPhoto(bytes, { masterPx })`). Household photos stay 2048 px.
- `lib/human/library-photos.ts`, the only writer of both tables: `approveLibraryCandidate`, `rejectLibraryCandidates`, `removeLibraryPhoto`, `setLibraryCover`, `undoLibraryRejection`, plus exporter classes `library-photos` and `library-photo-decisions` (not household scoped, prefixes `library-photos/` and `library-photo-decisions/`, keyed by slug and uid).
- Safety: `resetData('all')` deletes only `photos/` keys; household reset and account deletion leave library rows and files; `checkPhotos` also compares `library/` keys; `data/renames.json` handling follows slug-keyed library decisions.
- The new classes are listed in `EXCLUDED_TABLES` of `lib/legacy/bundle.ts`.

### Rules built in

- One cover per subject, enforced by partial unique indexes. The first photo of a subject is its cover. Cap of 3 photos per subject (`subject-full`).
- Approval is idempotent on `(subject, candidate_key)`: `ON CONFLICT DO NOTHING` on the candidate index, a per-subject advisory lock around cap and cover. The losing request deletes its files.
- Files are written before the transaction and deleted if it fails or loses; on removal they are deleted after the commit.
- Every write calls `markChanged` for `library-photos` or `library-photo-decisions` with a null household (`sync_state` is nulls-not-distinct).
- `created_by_person_id` is `ON DELETE SET NULL`, so deleting a person keeps the shared photo.
- The agent never approves: no file under `scripts/` may import the writer (static test). `pnpm photos:candidates` still only writes `data/photo-candidates.json`.

## Dependencies

- PR: WP6 (flag off), WP7. No dependency on the L2 to L6 packages; they depend on this one.
- No new env var, no credential, no remote call. Tests use PGlite and the in-memory blob store.

## Permission boundaries

- Writers: `lib/human/library-photos.ts` only. Static test `tests/library-photos-writers.test.ts`.
- Who may call the writers: nobody yet. L2 adds the server action and decides who is allowed (a signed-in operator allowlist is the working assumption).
- `scripts/` never imports the writers. Candidate files and the download allowlist (`lib/photos/remote.ts`) are unchanged.
- Library files are not part of any household reset, household export or household deletion.

## Later packages

| Package | Content |
| --- | --- |
| L2 | Approval server actions: who may approve, rate caps per person (uses the `created_by_person_id, created_at` index), download and licence recheck, flag `PHOTO_REVIEW_ENABLED` semantics |
| L3 | Review UI at `/photos/review` against the library tables; undo and removal |
| L4 | Read path: recipe and ingredient cards, collage rule, cover choice between household and library photos |
| L5 | Delivery: `/library-photos/<uid>/<variant>` route, caching, signed access, `/credits` for library photos |
| L6 | Backup, state sync and recovery coverage for `library/` blobs and the two classes (`STATE_SYNC_CLASSES`, backup receipts), launch check |

## Acceptance cases

1. `0022` creates both tables and all indexes; migration count is 23; `tests/migration-policy.test.ts` passes without `-- contract-ok`.
2. Schema parity test lists both tables as Postgres only.
3. Approval writes a 1280 px master and 640 px thumb under `library/<uid>/`, EXIF dropped, one row, one `approved` decision, null-household sync marks.
4. Two approvals of one candidate give one row, one cover, one decision, and the losing files are gone. A planted rival row inside the transaction is treated as a lost race.
5. Fourth photo for a subject returns `subject-full` and leaves no files.
6. Partial cover indexes reject a second cover; `setLibraryCover` swaps; `removeLibraryPhoto` promotes the next photo, records `rejected`, deletes files after commit.
7. Rejection batch is one transaction, skips live photos and unknown recipes; undo returns the candidate to the queue.
8. Export, import into a fresh database, export again: identical bytes, both classes. `blobs()` lists master with sha256 and thumb.
9. Rename: in-place rename rewrites slug-keyed decisions; rename onto an existing recipe moves photos (cap, duplicates, one cover) and decisions.
10. `resetData('all')`, household reset, household deletion keep library rows and `library/` files; person deletion nulls the author link.
11. `checkPhotos` reports library orphans and missing files; deleting reported orphans keeps live library files.
12. Static tests: one writer; no script reaches the writers.

## Gotchas

- `photo_decisions` (household) are keyed by recipe slug and an in-place rename (new slug not yet seeded) never rewrites them: `moveRecipe` only runs when both rows exist. Library decisions are fixed through the new optional `renameRecipeSlug` hook; the household class is not changed here.
- A rename onto an existing recipe leaves a photo behind when the target already has that candidate or is at the cap; the old recipe then stays (`hasRecipeData`).
- The library classes are in the operator-wide human export (no household scope) but are not in `STATE_SYNC_CLASSES`, backups or `readProcessedPhoto` yet. That is L6.
- `processPhoto` for the library does not change the 8 MB upload limit or the pixel limit.
