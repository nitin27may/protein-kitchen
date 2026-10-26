# L5: library photo review page with multi-select

Stage record required by CLAUDE.md. Follows `l4-batch-server.md` (server actions) and `l3-read-path.md`. Replaces the minimal `ReviewClient` adapter; ships in a later release than the page the owner uses today.

## Scope
- `/photos/review` filters live in the URL: `kind` (all, recipe, ingredient), `status` (pending default, decided), `missing=1` (only without a photo), `q`, `page`. 30 subjects per page. The page is server-rendered; `lib/photos/review-selection.ts` parses and builds the URL.
- Pending view: a tile per candidate with provider thumbnail (`referrerPolicy="no-referrer"`), title, author, licence, provider, licence and source links. The tile's whole label (image and title) is a native checkbox target at least 44 px tall. Space toggles, shift-click selects a range (the anchor's state is applied to every tile between), Shift+Space does the same by keyboard.
- Selection controls: Select all shown, Select all N matching (`listPendingKeys`, up to 2000, says so when truncated), Select first photo of each subject, Clear. The selection is a `Set` of `kind:slug:key` held in the client component, so it survives paging and filter changes in the session.
- Cap: subjects keep at most 3 library photos. The page knows each shown subject's current count (`ReviewItem.photoCount`) and warns when a selection exceeds the room left. The server still decides (`subject-full`).
- Sticky action bar (safe-area padding, 44 px buttons, offset above the phone bottom navigation): "23 selected (15 recipes, 8 ingredients)", Approve selected, Reject selected, Clear selection. A native `<dialog>` confirms with the counts; Escape cancels and focus returns to the bar button.
- Run: approve in chunks of 6, reject in chunks of 200, one chunk at a time. `role="status"` text "Approving 9 of 23". Cancel stops after the current chunk and returns the untried items as not attempted. Per-item results (approved, already, subject-full, not-attempted, failed with the plain message, rejected). Failed and untried items stay selected; "Retry failed (n)" resends them (approval is idempotent). A chunk whose request throws or is aborted fails only its own items. `router.refresh()` at the end.
- Decided view (`lib/server/library-decided.ts`): approved library photos with Make cover and Remove (two-step), rejected candidates with Undo reject. Single-item Approve and Reject on pending tiles are kept.
- Curator gating is unchanged: the page 404s for non-curators.

## Design
All decisions that can be tested without a browser are in `lib/photos/review-selection.ts` (100% gates): keys, range select, counts, cap warnings, chunking, `runChunks`, result merging, retry set, URL params, paging. The components only render and call it.

## Test seam change
`fixtureFetch` serves `images/default.jpg` for any image URL that has no file of its own (including URLs with characters the name check rejects). Without that file nothing changes. `scripts/e2e-server.ts` now builds a per-run copy of `tests/fixtures/photos` in `.next-e2e-fixture/photos` (gitignored), adds `default.jpg` and a licence entry for every candidate in `data/photo-candidates.json`, and points `PHOTO_REMOTE_TEST_DIR` at it. A browser test makes one approval fail by deleting that candidate's licence entry from the copy, then restores it.

## Acceptance
- Vitest: `tests/review-selection.test.ts`, `tests/library-decided.test.ts`, seam default-image case; gates in `vitest.config.ts`.
- Playwright `tests/e2e/library-photo-review.spec.ts`: shift-click range, select all shown, first of each, select all matching, selection across paging; cancel and dropped request; approve across searches with dialog, Escape focus return, one failed item, Retry failed; bulk reject, Decided view undo, make cover, remove; 44 px targets and no horizontal overflow at 320, 375 and 390 px, bar above the bottom navigation; keyboard-only pass with visible focus; non-curator 404. Provider thumbnails are answered locally, nothing leaves the machine. The spec removes the photos it approved at the end.

## Known gaps
- Removing a photo does not purge a CDN copy (up to 30 days), see `l3-read-path.md`.
- Cap warnings use counts of subjects seen this session; unseen subjects (select all matching) count as empty until the server answers `subject-full`.
- A reject chunk reports every item as rejected when the server accepts the request; the server silently skips candidates it does not list.
