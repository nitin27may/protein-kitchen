# Plan: steps 10 (photos) and 11 (data debts)

Written 2026-10-23 from an Opus planning pass over the code. Supersedes the step 10 and 11 lists in `roadmap.md` and `handover.md` where they differ.

## Facts found while scoping
- `pnpm validate` passes with one warning: `kheera-raita` is 73 kcal per serving (floor 150 for meals, `scripts/validate.ts:136`).
- The falafel bowl's duplicated text is a `tip` copied from the part's bake step, not the step text, so the "repeats a part's step" check does not fire.
- CNF was down on 2026-10-23 (503).
- "Fortified milk" may already be resolved: CNF milk codes 61, 113, 114 in `data/nutrients/micros.json` carry vitamin D. `docs/nutrient-targets.md` is out of date on this.
- Most of the "eight unresolved" are micronutrient gaps, not missing macros. Paneer has IFCT2017-L003 macros with 15 nutrients `not_reported`. Soya chunks use a defatted soy flour stand-in (CNF 3324). Atta uses CNF 4500. Skyr, ultrafiltered milk and nutritional yeast are not in `/data`.
- `baked-falafel` sums to 273 g with chickpeas dry; the bowl uses 300 g, so falafel macros are overstated by about the soak gain.
- `baked-falafel-mix` (id 1) is still in `db/app.db` because `data/renames.json` is `{}`.
- `resetCounts` has no count for `plan_progress`.
- `autoTags` uses `active_min`; the planner uses `effectiveActiveMin`.
- The romaine hero comes from `RecipeThumb` showing a single ingredient photo when `thumbs.length === 1`.
- Photos show today without approval, from `data/images.json` into `image` / `image_credit` columns (10 recipe and about 210 ingredient files in `public/`; about 16 consumers).
- `sharp` is only a transitive dependency. The default server-action body limit is about 1 MB. `withTx` callbacks are synchronous, so image work and blob writes cannot run inside a transaction. `ExportBundle.files` is text only.

## Step 10: photos
Order matters: ship the review page (10.6) before switching display to the DB (10.7), or every photo goes blank.

- **10.1 Fallback tiles and collage rule (S).** `components/IngredientTile.tsx` (aisle tint, line icon, name, state badge). Rule: own photo, approved photo, collage only with 3 or more ingredient photos, typographic card. Drop the 1- and 2-photo branches in `RecipeThumb` / `lib/recipes/thumbs.ts`. Test in `tests/thumbs.test.ts`. Done when the falafel bowl shows a card, not romaine.
- **10.2 BlobStore and image pipeline (M).** `lib/blob/{types,fs,memory,index}.ts` (`put/get/delete/exists`, root `UPLOADS_DIR`, default `uploads/`). `lib/photos/process.ts` with sharp: `.rotate()`, resize to a 2048 px master and 640 px thumb, WebP q80, input-pixel limit, jpeg/png/webp only, returns sha256, width, height. Route `app/photos/[uid]/[variant]/route.ts` (stable URL; on Neon it redirects to a signed link). Add `sharp` as a direct dependency. `scripts/backup.ts` copies `uploads/` beside the `.db`. Tests: EXIF/GPS gone, orientation applied, size capped; both stores pass one suite.
- **10.3 Schema and human module (M).** Migration `0011`: `photos` (uid, recipe_id or ingredient_slug with a CHECK for exactly one, origin `upload|commons|openverse`, blob_key, sha256, width, height, is_cover, position, source_url, licence, licence_url, author, title, timestamps, created_by_person_id) and `photo_decisions` (uid, candidate_key unique, subject, decision, timestamps). No BLOB columns; `lib/db/columns.ts` helpers only. `lib/human/photos.ts` is the only writer: process and `put` before `withTx`, delete the blob if the transaction fails, delete after commit on removal. Two exporter classes (`photos`, `photo-decisions`); optional `exportBlobs` / `importBlobs` hooks copy bytes between stores, checked by sha256. Reset: "Everything" clears both tables and copies blobs into the backup first. Tests: write, rename moves photos, round trip with different recipe ids and identical bytes.
- **10.4 Upload UI (M).** `components/photos/PhotoUpload.tsx`: `accept="image/*" capture="environment"`, `createImageBitmap` with `imageOrientation: "from-image"`, canvas to about 2048 px, JPEG via `toBlob` (Safari WebP encoding is unreliable), FormData. Server actions `uploadPhoto` / `deletePhoto`; raise the action body limit to about 6 MB. `RecipeDetail`: "Your photos" strip (cover, set cover, delete) and an optional "Add a photo of what you made" after "Cooked and tested" that never blocks the tick. Done when a real iPhone upload shows as the hero with no EXIF.
- **10.5 Candidate pipeline (M).** `scripts/photo-candidates.ts` replaces `fetch-images.ts`: Commons search and Openverse (`license=cc0,by,by-sa`), licence filter, dedupe by landing URL, at most 6 per subject. Output `data/photo-candidates.json` (library content, in git, zod-validated). Existing `images.json` entries become candidates (they need a re-query for the Commons file name).
- **10.6 Review page and credits (M).** `app/photos/review/page.tsx`: filter by recipes or ingredients and pending only; source, licence, author; Approve and Reject at 44 px or more; "Approve all shown" for ingredients only. Approval downloads from an allowlisted https host with timeout and size cap and re-checks the licence. `/credits` reads approved rows from the DB; BY and BY-SA show credit beside the photo. Sidebar link "Photos to review (n)".
- **10.7 Switch display to the DB and clean up (M).** `lib/server/photo-index.ts` returns photo URLs by recipe and ingredient; the 16 consumers take URLs. Migration `0012` drops `image` / `image_credit`; remove `public/recipe-images`, `public/ingredient-images` and `images*.json`; the service worker must not cache-first `/photos/*`.

## Step 11: data debts
- **11.1 Validator and data fixes (S).** `kcal_per_serving_ok` map in the overrides schema, entry for `kheera-raita`. Add `water-tap` to `besan-oat-muffins` (60 g), `spinach-cottage-cheese-bake` (60 g), `cottage-oat-pancakes` (60 g), `spiced-protein-chaas` (200 g) and drop "water is not counted" (macros per serving unchanged, grams per serving rise; report it). Reword `falafel-bowl` step 1 as its own reheat with its own cue; check `falafel-pita-wrap`. Extend `stepsRepeatingParts` to tips. Add `"baked-falafel-mix": "baked-falafel"` to `data/renames.json`.
- **11.2 Effective time in tags and planner (S/M).** `autoTags` takes effective active minutes; callers updated. `makeAheadMin` on `Candidate`; show the week's make-ahead total in the plan review. Diff the validate table, since `quick` may drop from some recipes.
- **11.3 Reset counts (S).** Count `plan_progress` and photo tables; update `SettingsClient` copy.
- **11.4 Nutrition sources (M, partly blocked).** Retry CNF for `water-tap` and `hummus-commercial`; switch only on a found code and report the macro change. Confirm fortified milk and fix the doc. Verify iron 1.8x and zinc +50% against the National Academies DRI reports before adding with a citation. Search IFCT for atta and roasted chana. Paneer micros stay partial. Soya chunks stay a labelled stand-in. Whatever stays unresolved is listed with its reason in `docs/nutrient-targets.md` and the memory file.
- **11.5 Falafel soaked weight (S, needs the owner).** After a measured soak gain, add it as `water-tap` in `baked-falafel` and recheck the bowl and wrap grams; report before and after.
- **11.6 Phone-width audit (M).** Scratch DB, Chrome at 375 and 390 px across every route, the picker, pin sheet, swap sheet, sidebar and bottom nav and the new photo screens. Fix overflow and targets under 44 px.

## Who does what
Alone: 10.1, 10.2, 10.3, 10.5, 10.7, 11.1, 11.2, 11.3, 11.6. Code alone, owner confirms: 10.4 (real iPhone), 10.6 (owner approves photos). 11.4 where sources answer; branded-only foods need the owner. 11.5 needs the owner to soak 150 g of dry chickpeas for 12 hours, drain and weigh.

## Risks
- No sharp, fetch or file work inside `withTx`. Order: process, put blob, transaction, delete blob on failure. A crash can leave orphan blobs, so add a `photos:gc` check run by `pnpm backup`.
- iPhone HEIC cannot be decoded by sharp's prebuilt binary, so the client resize is required. Call `.rotate()` before stripping metadata.
- Approval downloads come from a data file: allowlisted hosts, https only, size and time caps (server-side request forgery). Re-check the licence at approval. Openverse can index unclear or AI-made images, so human review is the guard; back off on rate limits.
- BY-SA needs visible credit and licence link; credits come from the DB after 10.7.
- `VACUUM INTO` plus copying `uploads/` is not atomic; copy `uploads/` after the DB.
- Ingredient photos are keyed by slug and `renames.json` covers recipes only; the validator should flag photo rows with an unknown slug.
- Neon move (step 18): store only blob keys, keep `/photos/<uid>/<variant>` stable, use `columns.ts` helpers and explicit `onDelete`.
- Hummus CNF values and the falafel soak gain both change macros in several recipes. Report; never apply silently.

## Decisions taken (owner can overturn)
1. Existing auto-matched photos are hidden until approved; they enter the review queue as candidates, with "Approve all shown" for ingredients.
2. No raw originals kept: the location-stripped 2048 px WebP is the master, plus a 640 px thumb. This changes the "originals in bucket" line in `plan-v3-publish-and-protect.md`.
3. The text export bundle carries photo metadata and sha256; bytes travel through `BlobStore` copy hooks, no base64 in the bundle.
4. Branded-only foods (skyr, ultrafiltered milk, nutritional yeast) stay out of the library unless the owner supplies a label photo; then a `LABEL` source is allowed.
5. Make-ahead time in the planner is shown only, with a soft warning above 90 minutes a week.
