import { AuthConfigurationError } from "./config";

/** Parsed SIGNUP_ALLOWLIST: exact addresses and whole domains (`@example.com`). Null means signup is open. */
export interface SignupAllowlist {
  emails: ReadonlySet<string>;
  domains: ReadonlySet<string>;
}

export const normaliseEmail = (email: string) => email.trim().toLowerCase();

/** Unset or blank means open signup. Malformed entries fail startup without echoing the value. */
export function parseSignupAllowlist(raw: string | undefined): SignupAllowlist | null {
  const entries = (raw ?? "").split(",").map(normaliseEmail).filter(Boolean);
  if (entries.length === 0) return null;
  const emails = new Set<string>();
  const domains = new Set<string>();
  for (const entry of entries) {
    if (/\s/.test(entry) || entry.split("@").length > 2) throw new AuthConfigurationError("SIGNUP_ALLOWLIST holds an invalid entry.");
    if (entry.startsWith("@")) {
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(entry.slice(1))) throw new AuthConfigurationError("SIGNUP_ALLOWLIST holds an invalid entry.");
      domains.add(entry.slice(1));
    } else {
      const [local, domain] = entry.split("@");
      if (!local || !domain || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) throw new AuthConfigurationError("SIGNUP_ALLOWLIST holds an invalid entry.");
      emails.add(entry);
    }
  }
  return { emails, domains };
}

export function isAllowlisted(list: SignupAllowlist | null, email: string): boolean {
  if (!list) return true;
  const value = normaliseEmail(email);
  return list.emails.has(value) || list.domains.has(value.slice(value.lastIndexOf("@") + 1));
}

/** Presentation only (the sign-in page line); never parses or reveals entries. */
export function signupIsInviteOnly(env: Readonly<Record<string, string | undefined>>): boolean {
  return Boolean(env.SIGNUP_ALLOWLIST?.trim());
}

/** Resend's free tier allows 100 a day, so the cap must stay below that. */
export const DEFAULT_MAIL_DAILY_CAP = 60;
export function mailDailyCap(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env.MAIL_DAILY_CAP?.trim();
  if (!raw) return DEFAULT_MAIL_DAILY_CAP;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < 1 || value > 99) throw new AuthConfigurationError("MAIL_DAILY_CAP must be a whole number from 1 to 99.");
  return value;
}
