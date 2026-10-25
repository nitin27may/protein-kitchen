import { AuthScreen } from "@/components/auth/AuthScreen";

export const metadata = { title: "Sign in or create an account" };
export default async function SignIn({ searchParams }: { searchParams: Promise<{ next?: string; emailLinkError?: string }> }) {
  const params = await searchParams;
  return <AuthScreen initial="code" next={params.next} emailLinkError={params.emailLinkError === "1"} />;
}
