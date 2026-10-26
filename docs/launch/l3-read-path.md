# L3: library photos read path

Stage record required by CLAUDE.md. Follows `wp8-library-photos.md` (L1 data layer) and `l2-curator.md`.

## Scope
Approved library photos (`library_photos`) are shown to everyone, signed out included, and credited publicly. No write path, no review UI (L4, L5).

## Design
- `lib/library-photos/manifest.ts`: `libraryPhotoManifest()` wraps one DB read in `unstable_cache(['library-photo-manifest','v1'], { tags: ['library-photos'], revalidate: 3600 })`. Plain JSON per subject: `cover` and ordered `photos` (`uid, w, h, title, author, licence, licenceUrl, sourceUrl, origin`, plus `candidateKey` for the merge; it never reaches the browser). L4 invalidates with `updateTag(LIBRARY_PHOTOS_TAG)` (`lib/library-photos/tags.ts`).
- Outage: the cached function throws, so Next does not cache a failure; the wrapper logs `LIBRARY_PHOTO_MANIFEST_UNAVAILABLE` and returns empty. Pages never fail over photos.
- `lib/library-photos/model.ts`: pure types and view builders. The signed-out loaders (`lib/library/anonymous.ts`) import only this, so the inventory test still proves they reach no database, auth or blob code.
- Route `/library-photos/<uid>/<variant>`: GET only, reads no session or header. `public, max-age=86400`, `CDN-Cache-Control: public, max-age=2592000, stale-while-revalidate=86400`, nosniff, CORP same-origin, ETag from the master sha256 (`-thumb` suffix for the thumbnail). 404 is `public, max-age=60`; a DB or store failure is 503 `no-store`. `/photos/<uid>/<variant>` stays `private, no-store`.
- `next.config.ts`: the private catch-all excludes `library-photos/`; a second entry gives that path the security headers only.
- Members: `getPhotoIndex`, `getRecipePhotos`, `getIngredientPhotos`, `getCreditedPhotos` merge the manifest. Household rows first, then library rows. Cover: your uploaded cover, else the library cover, else a household candidate cover. A household photo with the same `(subject, candidate_key)` as a library photo is hidden. Another household's rows are never read. `PhotoView.scope` is `household|library`; remove and make-cover show for household photos only.
- `/credits` is public. Signed out: library credits. Member: library plus the household's credited candidates. Every entry links the title to its source and the licence to its terms, with the resize/WebP note. "Review more photos", the sidebar link and the Settings link need `photoReviewEnabled()` and `isCurator`.
- `public/sw.js` only handles `/_next/static/` and `/icon.svg`; a test proves `/photos/` and `/library-photos/` are never taken over.

## Acceptance
Manifest shape, caching arguments and degrade-to-empty; route headers and 404/503 behaviour against the private route; merge rules (PGlite, memory BlobStore); loaders look identical with an empty manifest; inventory test (no DB imports, `app/credits/page.tsx` added, `libraryPhotoManifest` allowed pre-guard); `next.config` header matching; Playwright `tests/e2e/library-photo-public.spec.ts`.

## Gotchas
- The manifest is cached for an hour. Until L4 calls `updateTag`, an approval appears within an hour. The browser fixture therefore approves its photo (through the L1 writer, in `tests/e2e/setup.ts`, disposable loopback database only) before the server serves its first request.
- A removed photo can stay in a CDN for up to 30 days (`CDN-Cache-Control`); L4/L5 need a purge step on removal.
- The review page itself is not yet curator-gated (L4); only the links are.
- A household candidate-origin cover loses to the library cover; "Make cover" on it has no visible effect while a library cover exists.
- `e2e-server` sets `PHOTO_CURATOR_EMAILS` to the browser fixture account so the existing Settings review link test keeps working.
