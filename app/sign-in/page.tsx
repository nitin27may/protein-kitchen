import { AuthScreen } from "@/components/auth/AuthScreen";
import { legacyInviteToken } from "@/lib/auth/browser";

export const metadata = { title: "Sign in or create an account" };
export default async function SignIn({ searchParams }: { searchParams: Promise<{ next?: string; invite?: string; emailLinkError?: string }> }) {
  const params = await searchParams;
  return <AuthScreen initial="code" next={params.next} invite={legacyInviteToken(params.invite)} emailLinkError={params.emailLinkError === "1"} />;
}
