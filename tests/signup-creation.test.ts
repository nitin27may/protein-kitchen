import { APIError } from "better-auth/api";
import { describe, expect, it } from "vitest";
import { assertUserCreation, permitsUserCreation, USER_CREATION_PATHS } from "../lib/auth/signup";

describe("user creation gate", () => {
  it("permits only the code and email-link endpoints", () => {
    for (const path of USER_CREATION_PATHS) expect(permitsUserCreation(path)).toBe(true);
    for (const path of [undefined, "", "/sign-up/email", "/sign-in/email", "/email-otp/verify-email"]) expect(permitsUserCreation(path)).toBe(false);
  });
  it("accepts a verified user created through a permitted endpoint", () => {
    expect(() => assertUserCreation("/sign-in/email-otp", true)).not.toThrow();
    expect(() => assertUserCreation("/magic-link/verify", true)).not.toThrow();
  });
  it.each([
    ["/sign-up/email", true], [undefined, true], ["/sign-in/email-otp", false], ["/magic-link/verify", undefined], ["/magic-link/verify", null],
  ] as const)("refuses path %j with emailVerified %j", (path, verified) => {
    expect(() => assertUserCreation(path, verified)).toThrow(APIError);
    expect(() => assertUserCreation(path, verified)).toThrow("proving ownership of its email address");
  });
});
