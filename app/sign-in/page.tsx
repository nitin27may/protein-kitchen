import { AuthScreen } from "@/components/auth/AuthScreen";

export const metadata = { title: "Sign in" };
export default async function SignIn({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  return <AuthScreen initial="password" next={(await searchParams).next} />;
}
