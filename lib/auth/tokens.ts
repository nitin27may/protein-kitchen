import { createHash, timingSafeEqual } from "node:crypto";

export const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");

export function secretsMatch(submitted: string, expected: string) {
  return timingSafeEqual(Buffer.from(tokenHash(submitted), "hex"), Buffer.from(tokenHash(expected), "hex"));
}
