# WP3: health endpoint and hosted production smoke

Part of "Launch: single production environment" in `docs/plan-v3-publish-and-protect.md`. Kept in its own file so parallel launch PRs do not conflict.

## Scope

1. `GET /api/health`: public, unauthenticated, `Cache-Control: no-store`. Returns only `{ ok, release, database, library }`.
   - `release` comes from `APP_RELEASE_SHA`, inlined at build time through `env` in `next.config.ts` (server-only, not `NEXT_PUBLIC`). Anything that is not a hex commit hash is reported as `unknown`.
   - `database` is `ok` or `unavailable`. `library` is `exact`, `compatible` (this build is within the last-10 window of seeded versions) or `stale`.
   - HTTP 503 when the database is unavailable or the library is stale. No values, hosts or error text are ever returned. If the database cannot be reached, `library` is reported as `stale` because it cannot be confirmed.
   - The probe uses its own pool accessor (`getHealthDb`) so a stale library is reported, not thrown by the request-time version gate.
2. `pnpm deploy:smoke:production -- --stage=candidate|live` (`scripts/smoke-production.ts`, logic in `lib/smoke/production.ts`).
3. `vercel.json`: `{"regions":["cle1"],"git":{"deploymentEnabled":false}}`.

## Smoke rules

- `--stage=candidate`: `DEPLOYMENT_URL` (bare https `*.vercel.app` origin) and `PRODUCTION_PROTECTION_BYPASS`. The `x-vercel-protection-bypass` header is attached only when the request origin equals the deployment origin; any other origin is refused before the request is made. Redirects are never followed.
- `--stage=live`: `PRODUCTION_ORIGIN` and `DEPLOYMENT_URL`; no bypass is sent. Also asserts the generated deployment URL answers 401/403 or redirects off its own origin without the bypass.
- Both: `EXPECTED_SHA` (commit hash). Checks:
  - 200, `text/html` and a non-empty `<h1>` on `/`, `/recipes`, `/ingredients`, `/recipes/tofu-burrito-bowl`, `/ingredients/tofu-extra-firm`, `/sign-in`.
  - On those pages the headers the app sets in `next.config.ts`: `Cache-Control` contains `private` and `no-store`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`. (`Referrer-Policy` is also set but not asserted.)
  - `/account` redirects to `/sign-in` on the same origin.
  - `/api/health`: 200, `no-store`, exactly the four keys, `ok`, `database: ok`, `library: exact`, `release === EXPECTED_SHA`. Deployment checks stay exact, not `compatible`.
  - A POST to `/api/auth/email-otp/send-verification-otp` with `Origin: https://foreign.invalid` must get 403 (auth origin check rejects it before any mail is composed). The address in the body is on the reserved `.invalid` TLD.
- No other writes, no mail. Output is `PASS`/`FAIL` plus the check name only (paths, never hosts, headers or bodies). Exit code is non-zero if any check fails or the arguments are invalid.

## Acceptance

- Health redaction holds for every failure mode (connection error carrying a URL, rejected open, non-Error rejection, data-load failure, unseeded database); library states exact, compatible and stale are covered with PGlite.
- Smoke: argument and origin parsing, the bypass header is never sent to another origin, each failing check yields a non-zero exit (fake fetch only).
- `tests/access-inventory.test.ts` lists the health route as public, GET-only and session-free.
- Per-file 100% coverage gates for `lib/health/status.ts`, `lib/smoke/production.ts`, `app/api/health/route.ts`.

## Gotchas and owner checks

- Hobby plan: function region selection through `vercel.json` `regions` must be verified by the owner after the first deploy (Vercel dashboard, Functions region). If Hobby ignores or rejects it, remove the field.
- `git.deploymentEnabled: false` disables Git-triggered deploys; all deploys come from the GitHub Actions job.
- The workflow (separate PR) must export `APP_RELEASE_SHA` before `vercel build` and pass the same value as `EXPECTED_SHA`.
- `next.config.ts` sets `Cache-Control: private, no-store` on every path, including `/api/health`; the route also sets `no-store`. The smoke accepts any value containing `no-store` for health.
- The 403 check relies on better-auth's origin check; it has not been run against a hosted deployment from this change (no remote contact is allowed here).
