import { AuthScreen } from "@/components/auth/AuthScreen";

export const metadata = { title: "Sign in" };
export default async function SignIn({ searchParams }: { searchParams: Promise<{ next?: string; emailLinkError?: string }> }) {
  const params = await searchParams;
  return <AuthScreen initial="password" next={params.next} emailLinkError={params.emailLinkError === "1"} />;
}
