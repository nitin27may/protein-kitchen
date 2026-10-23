# Publish and protect: Postgres, auth, GitHub backup, Vercel

Status: proposed, not started. Written 2026-10-23. Runs AFTER the UI work in `plan-v2-experience.md`, with one exception (PR 0).

## Why this is more than a hosting change

Today there is no login, no authorisation check in any Server Action, a synchronous SQLite data layer, `VACUUM INTO` backups, and a `setInterval` reminder loop. None of that works on Vercel. Tailscale currently keeps the app off the internet; publishing removes that.

Verified in the code: `app/actions.ts` has no auth anywhere; `swapSlot`, `setPortion`, `setManualChecked` and `removeManualItem` do not check that the item belongs to the plan; `api/push/subscribe` trusts a person id from the request body; `api/plan/[id]/export` is open and plan ids are sequential (an IDOR); `lib/server/context.ts` reseeds at request time; `public/sw.js` caches personal pages after sign-out. `.env.local` and `.neon` currently point at the Neon `production` branch, so any seed, reset or test run with those settings would write to production (the app still uses SQLite, so nothing does today). `.gitignore` misses the SQLite `-wal` and `-shm` files, `.env` and `.env.production`.

## Decisions recommended (owner to confirm)

1. Self-hosted `better-auth` with the Drizzle adapter on Neon Postgres, not Neon Auth (Neon Auth has no sign-up hooks, cannot make sign-up invite-only, and cannot send verification links from its shared sender). Turn off the provisioned Neon Auth.
2. Do PR 0 (git repo, GitHub, CI) now, before the rest of the UI work.
3. PR 1a, an async facade: make `queries.ts` and the action helpers async now, so the later Postgres move is mechanical.
4. Sign-in: email and password, plus an emailed 6-digit code. No magic links (the installed iPhone home-screen app has its own cookie store, so links open in Safari). No social login yet.
5. Two roles, owner and member. Members cannot see another person's height, weight or birth date. Only owners reset data, sync, restore or invite.
6. One household per deployment, no `household_id`. A `household_members` table links login users to roles and optionally to a profile. A profile can exist without a login. No email column on `people`: the login email lives on the auth user, and pending emails on `invitations`.
7. Ratings and favourites per person; `tested` and `banned` stay household-wide.
8. Library content is git-first. Human-owned data created in the app (feedback, links, photo approvals, saved views, routine choices) is exported nightly and on demand to a separate private state repo through a GitHub App. Each data class syncs in one direction only.
9. Health data (profiles, weights, plans) never goes to git in plaintext. It stays in Neon (Launch plan recommended for 7-day point-in-time restore) plus a nightly age-encrypted dump to a private vault repo. The age private key lives only with the owner.
10. Photos: originals stay in the Neon bucket; WebP derivatives mirror to the state repo. Keep a `BlobStore` interface so Vercel Blob can replace it.
11. Reminders run from an external scheduler, evening window only, calling a cron endpoint; Vercel Hobby cron is once a day, and an all-day schedule would use up the free compute hours.
12. Preview deployments copy production data, so they need Vercel Deployment Protection, a unique auth secret each, and push and uploads off.
13. Domain: a subdomain you own, with email through Resend's free tier. GitHub Pro (about $4 a month) if branch protection cannot be enforced on the private repo.
14. Turn off Neon Realtime for now.

## Rules for the UI work meanwhile (so the migration is cheap)

- New data functions are `async`, even on SQLite, and no I/O inside a transaction.
- Add columns only through a `lib/db/columns.ts` with portable helpers (`json`, `bool`, `isoDate`, `isoTimestamp`). No `strftime`, `json_extract` or rowid reliance. Explicit `onDelete` on every foreign key.
- Human-owned rows carry `uid`, `created_at`, `updated_at`, `created_by_person_id`, and are written only through one `lib/human/` module that also marks the data class changed in `sync_state`. Exports use slugs and uids, never database ids.
- Start the exporter now (`lib/human/export.ts` and `import.ts`) and add every new human-owned table to it with a round-trip test.
- Photo storage behind a `BlobStore` interface (filesystem now, bucket later); resize on the phone before upload.
- A `data/renames.json` (old slug to new slug) so renaming `baked-falafel-mix` does not orphan feedback.
- Every new user table goes into `RESET_SCOPES` and `resetCounts` in `lib/server/reset.ts`.

## Delivery order (sizes: S 2-4 h, M 5-10 h, L 12-20 h)

| # | PR | Depends on | Size |
|---|---|---|---|
| 0 | Repo, `.gitignore` fixes, gitleaks, pre-commit hook, CI, protection, Dependabot | none | S |
| 1 to 12 | UI plan v2 (PR 1 prep tasks, 2 filters, 3 filters elsewhere, 4 composite data, 5 parts UI, 6 cook mode, 7 links, 8 routines, 9 plan steps, 10 Today, 11 photos, 12 photo review) | per v2 doc | see v2 doc |
| 1a | Async facade, `lib/human`, `columns.ts`, exporter skeleton and round-trip test | 1 | S |
| 13 | Finish the async conversion | 12 | M |
| 14 | Postgres baseline schema (all tables, auth, household, sync), node-postgres pool, PGlite and testcontainers tests, `vercel-build` | 13 | L |
| 15 | Migrate and seed pipeline, dev-branch workflow and guard, SQLite import script with checksum verification, rehearsal | 14 | M |
| 16 | Better Auth core: config, Resend, rate limits, `proxy.ts`, sign-in, code and reset pages, bootstrap claim | 14 | L |
| 17 | Authorisation everywhere: guards, IDOR fixes, push bound to the session, service worker hardening, security headers, per-person feedback | 16 | M |
| 18 | Household and account UI: invitations, profile login section, members and roles, account page, delete and export | 17 | M |
| 19 | `BlobStore` on the Neon bucket, signed-URL serving route | 14, 11 | S/M |
| 20 | State repo sync: GitHub App, commits, nightly cron, Sync now, status banner | 15, 19, 7, 12 | M |
| 21 | Vault backups, reset backup on Postgres, `pnpm backup` and `restore`, restore test, runbook | 20 | M |
| 22 | Go-live: Vercel integration, environment variables, reminder cron, domain, DNS for email, final data migration, cutover | 17, 18, 21 | M |

Group 2 (PRs 14 to 22) is about 95 hours.

## Key risks

- Fix the `.env.local` and `.neon` production pointer before any Postgres work: use a long-lived `dev` branch and a startup guard that refuses to run in development against `production`.
- Neon preview branches copy production data.
- Seeding at build writes to production before promotion, so migrations must be expand-only.
- Postgres `count(*)` returns a bigint string; ids differ between databases, so exports use slugs and uids.
- Free-plan point-in-time restore is 6 hours, so the vault is the real backup until a paid plan.
- Better Auth may need zod 4 while the app uses zod 3. Check before PR 16.
- Phones must re-subscribe to push on the new domain with new VAPID keys.
- Not verified yet: the `neon checkout` create flag, bucket credentials on preview branches, Vercel's exact client-IP header, whether GitHub rulesets work on this private repo.

## Go-live checklist (short)

All of PRs 0 to 21 merged with CI green including the restore round trip; domain and email DNS verified; environment variables set as Sensitive; previews protected; Neon Auth off; final SQLite backup taken and the import verified by counts and checksums; owner signs up and claims the household; one member invited and checked against the role table; IDOR checks by hand; a reminder received on Android and on an installed iPhone app; first state sync and vault backup succeeded; restore drill done into a throwaway branch; the old homelab instance kept read-only for two weeks.
