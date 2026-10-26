import { AuthConfigurationError } from "./config";
import { normaliseEmail } from "./allowlist";

/** Library photo curators are exact addresses only, and kept few on purpose. */
export const MAX_CURATORS = 5;

const ADDRESS = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/**
 * Parses PHOTO_CURATOR_EMAILS: comma-separated exact addresses, trimmed and lower-cased. Unset or blank means no
 * curators. Anything malformed (domain entries, bad addresses, more than 5 distinct entries) throws without echoing
 * the value. Pure: no database or request access, so the deployment check can share it.
 */
export function parseCuratorEmails(raw: string | undefined): ReadonlySet<string> {
  const entries = (raw ?? "").split(",").map(normaliseEmail).filter(Boolean);
  const emails = new Set<string>();
  for (const entry of entries) {
    if (entry.length > 254 || !ADDRESS.test(entry)) throw new AuthConfigurationError("PHOTO_CURATOR_EMAILS holds an invalid entry.");
    emails.add(entry);
  }
  if (emails.size > MAX_CURATORS) throw new AuthConfigurationError(`PHOTO_CURATOR_EMAILS may list at most ${MAX_CURATORS} addresses.`);
  return emails;
}
