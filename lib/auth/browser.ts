type AuthPath = "/sign-up/email" | "/sign-in/email" | "/sign-in/email-otp" | "/sign-out" |
  "/email-otp/send-verification-otp" | "/email-otp/verify-email" |
  "/email-otp/request-password-reset" | "/email-otp/reset-password";

export async function authRequest(path: AuthPath, body: object, headers: Record<string, string> = {}) {
  let response: Response;
  try {
    response = await fetch(`/api/auth${path}`, {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Could not reach the server. Check your connection and try again.");
  }
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => null);
    const message = data && typeof data === "object" && "message" in data && typeof data.message === "string"
      ? data.message : "Authentication failed. Please try again.";
    throw new Error(response.status === 429 ? "Too many attempts. Wait a minute before trying again." : message);
  }
}

export function safeAuthReturn(value?: string) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\x00-\x20]/.test(value)) return "/";
  const url = new URL(value, "https://return.invalid");
  if (["/sign-in", "/sign-up", "/verify-email", "/reset-password", "/onboarding"].includes(url.pathname)) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}
