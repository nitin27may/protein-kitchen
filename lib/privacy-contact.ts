type Environment = Readonly<Record<string, string | undefined>>;

export type PrivacyContact =
  | { kind: "address"; email: string }
  | { kind: "not-set" }
  | { kind: "hidden" };

export const CONTACT_NOT_SET = "Contact address not set yet.";

const ADDRESS = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/**
 * The privacy contact comes only from PRIVACY_CONTACT_EMAIL; no address is ever written into the code. In production the
 * deployment check requires the variable, so an unset value there shows nothing instead of a placeholder. Elsewhere an
 * unset value says so, which keeps a missing address visible during development.
 */
export function privacyContact(env: Environment = process.env): PrivacyContact {
  const value = env.PRIVACY_CONTACT_EMAIL?.trim();
  if (value && ADDRESS.test(value)) return { kind: "address", email: value };
  return env.VERCEL_ENV === "production" ? { kind: "hidden" } : { kind: "not-set" };
}
