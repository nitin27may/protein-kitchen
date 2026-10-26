# WP5: protect public signup from mail abuse

Part of the launch stage in `docs/plan-v3-publish-and-protect.md` (item 9, "Mail limits"). Status: implemented in `feat/mail-caps`, not merged.

## Scope

1. Table `mail_sends(id, recipient_hash, purpose, created_at)` with an index on `(recipient_hash, created_at)`. Migration `0021_mail_sends` is expand-only. The hash is `HMAC-SHA256(BETTER_AUTH_SECRET, "mail-recipient:v1:" + normalised email)`. The address is never stored.
2. `lib/auth/mail-limits.ts` wraps the auth sender in `lib/auth/server.ts`, so codes, sign-in links and household-association mail all pass through it.
3. `SIGNUP_ALLOWLIST` and `MAIL_DAILY_CAP` are read in `lib/auth/config.ts` (parsing in `lib/auth/allowlist.ts`) and documented by name in `.env.example`. `lib/deployment/check-production.ts` is not touched (another PR owns it).
4. The sign-in page shows "Sign-up is invite-only for now." when the allowlist is set.

## Behaviour

Per send, in one transaction: take `pg_advisory_xact_lock(hashtext(recipient_hash))`, then a global lock (fixed order, no deadlock), delete rows older than 2 days, count, and insert the ledger row. The provider is called after the commit so the lock is not held across the network.

| Limit | Value | Counted over |
|---|---|---|
| Per recipient | 3 | 15 minutes |
| Per recipient | 10 | UTC day |
| Global | `MAIL_DAILY_CAP`, default 60, valid 1 to 99 | UTC day, real sends only |

Over a cap the sender throws before any provider call. Better Auth then returns the existing generic 503 ("We could not send the email code. Please try again." or the link equivalent). The cap check does not look at whether an account exists.

Allowlist (only when `SIGNUP_ALLOWLIST` is set). An address receives mail if it is listed (exact or `@domain`, no subdomains), already has an account, or has a pending (not accepted, declined, revoked or expired) household association. The household-association notice itself is always sent because the owner created the association. Any other address gets nothing sent and the ordinary success response. Its ledger row is stored as `blocked:<type>`: it counts toward the per-recipient caps (so the 503 pattern matches an allowed address) and is checked against the global cap, but does not consume the global budget. `assertUserCreation` takes an `invited` flag and `createAuth` refuses to create a user for an address that is neither listed nor invited, as a backstop if a code exists anyway.

## Acceptance cases

- Fourth send to one recipient in 15 minutes and eleventh in a UTC day: refused, provider not called.
- Two simultaneous sends at the last slot: exactly one succeeds. Six simultaneous sends to different recipients with cap 3: exactly three succeed.
- Global cap reached: any recipient refused, blocked addresses do not consume it.
- Allowlist unset: unchanged behaviour. Set: listed, existing and invited addresses are mailed; others are not.
- Responses (status, headers, body) are byte-identical for listed, existing, invited and blocked addresses (`tests/auth-flows.test.ts`).
- Non-allowlisted verified user creation is refused with a valid code.
- Ledger rows older than 2 days are deleted on the next send. No address appears in the table.

## Tests

Vitest with PGlite: `tests/mail-limits.test.ts`, the new block in `tests/auth-flows.test.ts`, `tests/auth-config.test.ts`, `tests/signup-creation.test.ts`. Playwright: `tests/e2e/mail-caps.spec.ts` uses the test mailbox. The dev server inherits `SIGNUP_ALLOWLIST` from the environment, so the spec has two modes:

```
pnpm test:e2e tests/e2e/mail-caps.spec.ts                                   # open signup (default suite)
SIGNUP_ALLOWLIST=listed@example.test pnpm test:e2e tests/e2e/mail-caps.spec.ts   # invite-only; run this spec alone
```

The rest of the e2e suite assumes open signup, so the invite-only mode is run for this spec only.

## Gotchas

- PGlite is single-connection, so the race tests prove the logic and ordering but not the Postgres advisory lock itself. The lock is the standard pattern already used in `lib/auth/household.ts`.
- Timing: with the allowlist on, a blocked address returns without the provider round trip, an existing account does not. A patient attacker could tell them apart by latency. The response body and status are identical; the latency gap is accepted for a friends-only phase and disappears when the allowlist is removed.
- A reserved ledger row is kept when the provider call fails, so a failing provider cannot be used to bypass the caps. A person who hits a transient failure uses one of their 3 slots.
- Blocked attempts write one row each (bounded by the per-recipient cap per hash and the 2-day prune). A flood of distinct random addresses grows the table until pruned; the existing per-IP limit (5 per minute on `/email-otp/*`) bounds the rate.
- The global cap also stops legitimate sign-ins once reached. Raise `MAIL_DAILY_CAP` (maximum 99) or wait for the UTC day to roll over.
- Changing `BETTER_AUTH_SECRET` resets every recipient's counters (new hashes). Acceptable.
- Per-recipient limits apply to all mail types, including password-reset and verification codes.
