import { z } from "zod";
import type { AuthCodeMail, AuthMail } from "./create";
import { AuthConfigurationError } from "./config";

const subjects = {
  "email-verification": "Verify your Protein Kitchen email",
  "sign-in": "Your Protein Kitchen sign-in code",
  "forget-password": "Reset your Protein Kitchen password",
  "change-email": "Confirm your Protein Kitchen email change",
} satisfies Record<AuthCodeMail["type"], string>;

export function resendAuthSender(env: Readonly<Record<string, string | undefined>>, request: typeof fetch = fetch) {
  const apiKey = env.RESEND_API_KEY;
  const sender = z.string().email().safeParse(env.AUTH_EMAIL_FROM);
  if (!apiKey || !sender.success) throw new AuthConfigurationError("Set RESEND_API_KEY and a verified AUTH_EMAIL_FROM email address for auth delivery.");
  return async (mail: AuthMail) => {
    const response = await request("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      redirect: "error", signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        from: sender.data, to: [mail.email],
        subject: mail.type === "sign-in-link" ? "Your Protein Kitchen sign-in link" : subjects[mail.type],
        text: mail.type === "sign-in-link"
          ? `Sign in to Protein Kitchen:\n${mail.url}\n\nThis link can be used once and expires in five minutes. If you did not request it, ignore this email.`
          : `Your Protein Kitchen code is ${mail.otp}.\n\nIt expires in five minutes. If you did not request this code, ignore this email.`,
      }),
    });
    if (!response.ok) throw new Error("Email provider rejected authentication delivery.");
    const result: unknown = await response.json();
    if (!z.object({ id: z.string().min(1) }).safeParse(result).success) {
      throw new Error("Email provider returned an invalid authentication delivery receipt.");
    }
  };
}
