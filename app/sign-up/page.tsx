import { AuthScreen } from "@/components/auth/AuthScreen";
import { legacyInviteToken } from "@/lib/auth/browser";

export const metadata = { title: "Sign in or create an account" };
export default async function SignUp({ searchParams }: { searchParams: Promise<{ invite?: string }> }) {
  return <AuthScreen initial="code" invite={legacyInviteToken((await searchParams).invite)} />;
}
