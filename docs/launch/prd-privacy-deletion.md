# PR D: privacy page and self-service account deletion

## Scope

1. Account deletion works for a normal new user. Re-authentication is a fresh email code for the session's own address (an account with a password may use the password instead). The sole member of a household, who is its owner, deletes the account and the household together in one transaction.
2. A public `/privacy` page, a plain confirmation page at `/account-deleted`, and links to the privacy page from the sidebar footer (every shell state), under the sign-in form, and from `/account`.
3. `PRIVACY_CONTACT_EMAIL` becomes a required plain production variable.

Out of scope: a deletion path for a member who leaves a household that stays (their meal profile stays, as before), off-site dumps, reminders, and any change to the photo model.

## Dependencies

- `lib/auth/household.ts` `deleteOwnAccount`, `lib/auth/account-deletion.ts` (Better Auth endpoint), `lib/auth/email-code.ts` (new), `lib/human/reset.ts` (`deleteHousehold`, new), the email-OTP plugin and `limitedSender` mail caps.
- `components/auth/DeleteAccountControls.tsx` (new), `components/auth/AccountControls.tsx`, `app/account/page.tsx`, `lib/server/household-account.ts` (`memberCount`).
- `app/privacy/page.tsx`, `components/PrivacyContent.tsx`, `lib/privacy-contact.ts`, `app/account-deleted/page.tsx`.
- `lib/deployment/check-production.ts` (one name added to the plain list), `.env.example`, `README.md`.

## Permission boundaries

- Deletion acts only on the authenticated session's own user. The body carries no user or household id. The code is looked up by the session user's email, never by anything the browser submits.
- The code is the email-OTP plugin's `email-verification` code, sent through `/api/auth/email-otp/send-verification-otp`, so the per-recipient and daily mail caps and the five-per-minute route limit apply. It lives 5 minutes, allows 3 wrong attempts, and is deleted when used. The row is locked in the deletion transaction, so two concurrent requests cannot both use it.
- A wrong guess burns an attempt and that write is committed even though the request is refused. A correct code is consumed in the same transaction as the deletion, so a failed deletion leaves the code usable.
- Human-owned data is removed only here, through `lib/human/reset.ts` (`clearHouseholdData` then `deleteHousehold`), inside the deployment lock. No page, action or script writes those tables.
- Photo bytes are deleted from the `BlobStore` after the commit. A failure is logged and does not fail the request; `pnpm photos:check` reports orphans.
- The privacy page reads no session and no database. The contact address comes only from `PRIVACY_CONTACT_EMAIL`; no address is written in the code.
- Nothing in `/data` changes.

## Behaviour

| Situation | Result |
|---|---|
| Sole member of a household | Account, sessions, accounts, invitations, memberships, every household table, profiles (birth date, weight), photos rows, then the household and the user are deleted in one transaction. Photo files are deleted after the commit. |
| Owner, other members exist, another verified owner with a profile exists | The user leaves. The household and the user's meal profile stay for the others (unchanged behaviour). |
| Owner, other members exist, no other owner | Refused: "Transfer ownership first." Nothing is written. |
| Member, other members exist | The user leaves, as before. |
| Several households | Each is handled by the rows above. A refusal in any one refuses the whole request. |
| Wrong, expired, exhausted, reused or other-address code | Refused with one message. No data changes. |

After success the session cookie is cleared and the browser goes to `/account-deleted`. The mail ledger keeps only hashes and is trimmed after 2 days.

### Privacy page facts and where they come from

| Statement | Source |
|---|---|
| Draft kept at most 14 days, 30-minute local copy, 24-hour pending action | `DRAFT_TTL_MS`, `MIRROR_TTL_MS`, `INTENT_TTL_MS` in `lib/plan/anon-draft.ts` (the test reads them) |
| Codes and links expire after 5 minutes | `lib/auth/email-code.ts`, magic link `expiresIn: 300` |
| Hosting Vercel, mail Resend, database Neon US East (Ohio), photos Neon object storage | `lib/auth/mail.ts`, `.env.example` (`BLOB_STORE=neon`, `us-east-2`), `docs/plan-v3-publish-and-protect.md` |
| 6 hours of Neon history, snapshots up to 7 days | `README.md` hosting paragraph, `DEFAULT_RETENTION_DAYS` in `lib/deployment/neon-snapshot.ts` |
| Mail log kept 2 days, hashed | `lib/auth/mail-limits.ts` |
| Download | `GET /api/account/export` (`app/api/account/export/route.ts`, `lib/server/account-export.ts`) |

Encrypted off-site dumps are planned and are deliberately not mentioned on the page.

## Acceptance cases

1. A passwordless sole owner deletes the account with a code; no row remains for the household in any table with a `household_id`, `person_id` or `plan_id` column (generic test); an unrelated household is unchanged.
2. Wrong, expired, exhausted, reused and other-address codes are refused and change nothing but the attempt counter.
3. An owner with other members and no other owner is told to transfer ownership first and nothing is written.
4. A failure inside the transaction rolls everything back, including the consumed code.
5. Photo files of the deleted household are removed; other files stay; a cleanup failure does not fail the request.
6. Browser: sign up by code, delete with a code, land on `/account-deleted`, stale cookies are refused, signing in again creates a different user and a different empty kitchen.
7. `/privacy` renders every section with and without `PRIVACY_CONTACT_EMAIL`; in production without it no placeholder and no address appears; headings run h1 then h2; links have descriptive text; the page imports nothing that reaches the database or a session.
8. The privacy link is present in the sidebar footer for visitor, setup and member, under the sign-in form (full and embedded), and on `/account`.
9. `pnpm db:check:production` fails when `PRIVACY_CONTACT_EMAIL` is missing from the Vercel production manifest.

## Gotchas

- The code email uses the `email-verification` template, so its subject reads "Verify your Protein Kitchen email". The Better Auth plugin only allows four code types, and a dedicated type would need a plugin change. The deletion form says what the subject will be.
- The sole-member rule is about household members, not about being the original owner. A household whose only other member is a pending invitation counts as sole; the invitation is deleted with it.
- `SNAPSHOT_RETENTION_DAYS` can be set up to 30. The privacy page states the default of 7. If the owner changes it, update the page.
- A user who leaves a shared household keeps their meal profile in it until an owner deletes the profile. The page and the account screen both say so.
- The deployment check needs `PRIVACY_CONTACT_EMAIL` as a plain Vercel Production variable. The owner supplies the value.
