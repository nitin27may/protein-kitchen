# WP7: import the old household data into your own account

## Decision

The first person to sign up no longer claims the legacy household. The owner signs up like anyone else, gets their own empty household, and imports the old single-household SQLite data into it from Settings. Every production write is an ordinary authenticated write into the caller's own household. No laptop connects to the production database, and no private bytes pass through CI.

## Scope

1. `pnpm legacy:bundle [--with-plans] /abs/source-copy.db /abs/bundle.json` runs locally. It opens a copy of the SQLite file read-only through `readSqliteSnapshot` (integrity check, foreign key check, per-table checksums), uses no network and no database URL, and refuses to overwrite its output.
2. `lib/human/legacy-household-import.ts` imports a verified bundle in one transaction under the household admission lock.
3. Settings, Household: an "Import from the old app" panel, shown only to owners when `LEGACY_IMPORT_ENABLED=true`.
4. Tests on PGlite, plus a retained Playwright journey.

## Bundle format (version 1)

JSON, sorted keys, `manifest.sha256` is the sha256 of the canonical `data` block and `manifest.counts` the per-class counts. Parsing rejects a wrong format, version, shape, checksum or counts, and never echoes file content in an error. Size limit 4 MB, under the 6 MB server action body limit.

Rows carry no database ids. Recipes, ingredients and habits are referenced by slug, rows by uid, people by `personKey(name, birthDate)`. Rows without a uid in the source get a uid derived from their natural key, so rebuilding a bundle from the same source gives the same uids. `data/renames.json` is applied to recipe slugs at build time and again at import time.

| Included always | Included with `--with-plans` | Never included |
| --- | --- | --- |
| people with preferences, recipe feedback (household-wide, touched rows only), recipe links, saved views, person routines, pantry, habit log | plan setups (person ids rewritten to person keys), plans, slots, portions, plan routines, grocery ticks, manual grocery items, part choices, plan progress, prep ticks | library tables, sync_state, push subscriptions, reminder logs, photos, photo decisions |

Plan ids inside prep tick keys (`night:<id>:...`, `prep:<id>:...`) become `@plan-N` references and are rewritten on import. A tick for a plan not in the bundle is dropped.

## Import rules

- Flag off: refused before anything is read. Caller must be an owner of the selected household (re-verified inside the transaction).
- Refused when the household already has plans, plan setups, feedback, links, saved views, a pantry or prep ticks, or when any uid in the bundle already exists in the database. A second run is therefore refused and changes nothing.
- New ids come from the Postgres identities. Recipes, ingredients and habits are mapped by slug. An unknown slug skips that row; counts per class and the unknown slugs (up to 25 per kind) are reported. A slot or setup whose references cannot be resolved is skipped with its dependents.
- Human-owned classes are written by `insertLegacy*` functions in their own `lib/human/` modules (feedback, links, saved views, routines). They keep the bundle's uid and timestamps.
- sync_state is not touched, and nothing outside the household is written.
- Optional link: the owner's membership takes a named bundle person. The starter profile is deleted only if nothing refers to it; otherwise it stays as a second person.
- Dry run: the same code runs, counts are collected, and the transaction rolls back. The commit button sends the file again with the previewed checksum, and the server refuses a different file.

## Acceptance cases

Covered in `tests/legacy-household-import.test.ts`, `tests/legacy-import-actions.test.ts`, `tests/legacy-bundle-script.test.ts` and `tests/e2e/legacy-import.spec.ts`:

1. Import with two other households present: neighbours' rows and all sync_state are byte-identical afterwards.
2. person_ids remap, renames, uid preservation, created-by remap.
3. Refusal on re-run, on a populated household, on a uid held by another household.
4. Bad checksum, tampered counts, wrong version, oversize, non-owner, flag off, unverified account, revoked access.
5. Unknown slug reporting; duplicates after a rename; missing people.
6. Dry run counts equal commit counts and leave no rows.
7. Rollback when a write fails part way.
8. Bundle build round trip: no ids, exclusions, stable checksum.
9. Browser: tampered file refused, dry run shown, link and commit, second run refused, 44 px targets, no horizontal scroll.

## Owner procedure

1. Stop the old app. Copy `db/app.db` (and migrate the copy if needed) to a private location. Never use the original.
2. `pnpm legacy:bundle /abs/copy.db /abs/bundle.json` (add `--with-plans` to bring plans). Keep the file private.
3. Sign up in production, finish nothing else. Set `LEGACY_IMPORT_ENABLED=true` for the import window and redeploy.
4. Settings, Import from the old app: choose the file, check it, review counts and left-out slugs, pick yourself, import.
5. Set the flag back to `false`. `pnpm db:check:production` fails while it is on.
6. Photos are not imported; upload or approve them again.

## Gotchas and known limits

- Manual grocery items belong to plans in the old schema, so they are only bundled with `--with-plans`.
- Imports are not marked in sync_state, so the shared-state export will not include imported rows until they are next edited.
- Sequences advance even for a dry run. Gaps in ids are harmless.
- The importer runs inside one function call; a very large plan history could approach the platform time limit. Rows are inserted in batches of 200.
- Database error text can contain row values. The action logs a code only.
