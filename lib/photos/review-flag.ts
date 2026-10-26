type Environment = Readonly<Record<string, string | undefined>>;

export const PHOTO_REVIEW_DISABLED_MESSAGE = "Photo review is not available yet.";

/**
 * Whether library photo candidate review (/photos/review and its approve/reject actions) is available.
 * Off by default in production, on elsewhere so local development and browser tests keep working. An explicit
 * "true" or "false" wins; any other value fails closed. Own uploads and /credits do not depend on this flag.
 */
export function photoReviewEnabled(env: Environment = process.env): boolean {
  const value = env.PHOTO_REVIEW_ENABLED?.trim().toLowerCase();
  if (value === undefined || value === "") return env.VERCEL_ENV !== "production";
  return value === "true";
}
