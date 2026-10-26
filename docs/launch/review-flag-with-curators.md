# Review flag with curators

Stage record for the deployment check change that lets a photo review window pass `pnpm db:check:production`.

## Scope

The owner runs library photo review as an open window on production: `PHOTO_REVIEW_ENABLED=true` and `PHOTO_CURATOR_EMAILS` set in Vercel, then a redeploy. The check used to fail with `CONFIG_FLAG_ENABLED` for any value but `false`, which blocked every pipeline deploy while the window was open.

## Rule

`PHOTO_REVIEW_ENABLED` may be `true` only when `PHOTO_CURATOR_EMAILS` is present and usable. All other launch flags (`STATE_SYNC_ENABLED`, `REMINDER_SCHEDULER_ENABLED`, `VAULT_ENABLED`, `LEGACY_IMPORT_ENABLED`) stay must-be-false.

| Flag value | Curators | Result |
| --- | --- | --- |
| unset, or `false` | any | pass, no review line |
| exactly `true` | plain, valid (`parseCuratorEmails`, at least one address) | pass, plus `OK runtime.review CONFIG_REVIEW_WINDOW_OPEN` |
| exactly `true` | sensitive (unreadable) | pass, presence is enough, same info line |
| exactly `true` | missing, blank or malformed | fail `CONFIG_FLAG_ENABLED PHOTO_REVIEW_ENABLED` |
| anything else (`TRUE `, `1`, `yes`, blank, hidden) | any | fail `CONFIG_FLAG_ENABLED PHOTO_REVIEW_ENABLED` |

Both modes follow the table. In `--runtime-manifest` mode the curators come from the manifest (`runtime.flags`, `runtime.review`). In the env-based check they come from the job environment (`config.flags`, `config.review`). The informational line has severity `ok`, so it never fails the run. Output stays value-free: only variable names and fixed codes.

## Operating the window

1. Set `PHOTO_CURATOR_EMAILS` and `PHOTO_REVIEW_ENABLED=true` in Vercel, redeploy.
2. Review photos.
3. Set `PHOTO_REVIEW_ENABLED=false`, redeploy.

## Gotchas

- A sensitive curator list cannot be read, so a malformed one is only caught at runtime, where `isCurator` fails closed.
- A malformed plain list also fails `runtime.curators` on its own.
- The runtime flag must still exist in the manifest (`runtime.required`).

## Acceptance

Cases in `tests/check-production.test.ts`, both modes: true with valid plain, sensitive; true with none, blank, malformed; `TRUE `, `1`, `yes`; unset and `false`; other flags not opened by curators; no value in output.
