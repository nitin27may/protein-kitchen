import { describe, expect, it, vi } from "vitest";
import { authConfiguration, AuthConfigurationError } from "../lib/auth/config";
import { resendAuthSender } from "../lib/auth/mail";

const configured = { BETTER_AUTH_URL: "https://kitchen.example.test", BETTER_AUTH_SECRET: "synthetic-test-session-secret-32chars" };
describe("explicit server auth configuration", () => {
  it("uses a fixed origin, server secret and Vercel's trusted IP boundary", () => {
    expect(authConfiguration({ ...configured, VERCEL: "1" })).toEqual({
      baseURL: configured.BETTER_AUTH_URL, secret: configured.BETTER_AUTH_SECRET, bootstrapSecret: undefined, isVercel: true,
    });
  });
  it.each(["localhost", "127.0.0.1", "[::1]"])("permits HTTP loopback only for local development (%s)", (host) => {
    expect(authConfiguration({ ...configured, BETTER_AUTH_URL: `http://${host}:3112` }).baseURL).toBe(`http://${host}:3112`);
  });
  it.each([
    { BETTER_AUTH_SECRET: "" }, { BETTER_AUTH_SECRET: "short" }, { BETTER_AUTH_URL: "" },
    { BETTER_AUTH_URL: "not-a-url" }, { BETTER_AUTH_URL: "http://kitchen.example.test" },
    { BETTER_AUTH_URL: "https://user:credential@kitchen.example.test" },
    { BETTER_AUTH_URL: "https://kitchen.example.test/login" },
    { BETTER_AUTH_URL: "https://kitchen.example.test/?secret=value" },
    { BETTER_AUTH_URL: "https://kitchen.example.test/#fragment" },
    { BETTER_AUTH_URL: "ftp://kitchen.example.test" }, { HOUSEHOLD_BOOTSTRAP_SECRET: "short" },
    { BETTER_AUTH_URL: "http://localhost:3112", VERCEL: "1" },
    { BETTER_AUTH_URL: "http://localhost:3112", NODE_ENV: "production" as const },
  ])("rejects missing/unsafe auth configuration (%j)", (override) => {
    expect(() => authConfiguration({ ...configured, ...override })).toThrow(AuthConfigurationError);
  });
  it("accepts a separate strong initial claim secret without exposing it publicly", () => {
    const bootstrap = "synthetic-bootstrap-secret-for-tests";
    expect(authConfiguration({ ...configured, HOUSEHOLD_BOOTSTRAP_SECRET: bootstrap }).bootstrapSecret).toBe(bootstrap);
  });
});

const mailEnv = { RESEND_API_KEY: "synthetic-provider-key", AUTH_EMAIL_FROM: "auth@example.test" };
const mail = { email: "cook@example.test", otp: "123456", type: "email-verification" as const };
describe("explicit, awaited auth code delivery", () => {
  it.each([{}, { RESEND_API_KEY: "synthetic" }, { ...mailEnv, AUTH_EMAIL_FROM: "invalid" }])("refuses an unconfigured provider", (env) => {
    expect(() => resendAuthSender(env)).toThrow(AuthConfigurationError);
  });
  it("sends a code to Resend's fixed endpoint and verifies the delivery receipt", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: "synthetic-mail-id" }));
    await resendAuthSender(mailEnv, request)(mail);
    expect(request).toHaveBeenCalledWith("https://api.resend.com/emails", expect.objectContaining({
      method: "POST", redirect: "error",
      headers: { Authorization: "Bearer synthetic-provider-key", "Content-Type": "application/json" },
      signal: expect.any(AbortSignal),
    }));
    const body = request.mock.calls[0]![1]!.body;
    expect(typeof body).toBe("string");
    expect(JSON.parse(String(body))).toMatchObject({
      from: mailEnv.AUTH_EMAIL_FROM, to: [mail.email], subject: "Verify your Protein Kitchen email",
      text: expect.stringContaining("123456"),
    });
  });
  it.each(["sign-in", "forget-password", "change-email"] as const)("labels the %s email appropriately", async (type) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: "synthetic" }));
    await resendAuthSender(mailEnv, request)({ ...mail, type });
    expect(request).toHaveBeenCalledOnce();
  });
  it("rejects provider errors without returning the private provider response", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("synthetic-private-error", { status: 403 }));
    await expect(resendAuthSender(mailEnv, request)(mail)).rejects.toThrow("Email provider rejected");
  });
  it.each([{}, { id: "" }, null])("rejects malformed success receipts (%j)", async (receipt) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(receipt));
    await expect(resendAuthSender(mailEnv, request)(mail)).rejects.toThrow("invalid authentication delivery receipt");
  });
  it("propagates network and non-JSON receipt failures to the sanitized auth boundary", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error("synthetic-network-error"));
    await expect(resendAuthSender(mailEnv, request)(mail)).rejects.toThrow("synthetic-network-error");
    request.mockResolvedValue(new Response("not JSON"));
    await expect(resendAuthSender(mailEnv, request)(mail)).rejects.toThrow();
  });
  it("sends a single-use link without presenting it as a numeric code", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: "synthetic-link-id" }));
    const url = "https://kitchen.example.test/api/auth/magic-link/verify?token=synthetic";
    await resendAuthSender(mailEnv, request)({ email: mail.email, type: "sign-in-link", url });
    expect(JSON.parse(String(request.mock.calls[0]![1]!.body))).toEqual({
      from: mailEnv.AUTH_EMAIL_FROM, to: [mail.email], subject: "Your Protein Kitchen sign-in link",
      text: `Sign in to Protein Kitchen:\n${url}\n\nThis link can be used once and expires in five minutes. If you did not request it, ignore this email.`,
    });
  });
});
