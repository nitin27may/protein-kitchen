# L2: who may approve library photos

## Scope
Library photo candidates (`/photos/review`) may be approved only by a curator: a signed-in, household-onboarded account whose email is verified and appears in `PHOTO_CURATOR_EMAILS`.

## Configuration
- `PHOTO_CURATOR_EMAILS`: comma-separated exact addresses, trimmed and lower-cased with `normaliseEmail`. No domains, at most 5 distinct entries. Unset or blank means no curators, in every environment.
- Malformed or oversized lists throw `AuthConfigurationError` from `parseCuratorEmails` without echoing the value. `isCurator` fails closed (returns false and logs a fixed line) on a bad list.
- New name on purpose: `HOUSEHOLD_OWNER_EMAIL` is forbidden in production.

## Code
- `lib/auth/curator-list.ts`: pure parser (shared with the deployment check, no DB or request imports).
- `lib/auth/curator.ts`: re-exports the parser, `isCurator(member)` (reads the auth user by `member.userId`; requires `emailVerified`), and `curatorDenial()`.
- `curatorDenial()` order, fixed: `actionDenial()`, `photoReviewEnabled()`, `photoWritesEnabled()`, `isCurator()`. Returns `{ ok: false, error }` or `null`. Nothing calls it yet; the review actions adopt it in a later PR.

## Deployment check (`lib/deployment/check-production.ts`)
- `PHOTO_REMOTE_TEST_DIR` (test seam for later PRs) is forbidden in config and in the runtime manifest.
- `PHOTO_CURATOR_EMAILS` is optional in the manifest and may be plain or sensitive. A plain value is format-checked (`runtime.curators`, `CONFIG_MALFORMED` on failure); a sensitive value cannot be read. The value is never printed.
- `PHOTO_REVIEW_ENABLED` is false unless a curator is configured. See `docs/launch/review-flag-with-curators.md`. Turn it off after review.

## Acceptance
Parse cases, `isCurator` against PGlite users (verified, unverified, unlisted, unset), `curatorDenial` order with mocks, check-production cases (valid, malformed, sensitive, forbidden seam).
