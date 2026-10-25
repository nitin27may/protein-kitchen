import { AuthScreen } from "@/components/auth/AuthScreen";

export const metadata = { title: "Sign in or create an account" };
export default function SignUp() { return <AuthScreen initial="code" />; }
