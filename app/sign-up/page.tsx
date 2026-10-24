import { AuthScreen } from "@/components/auth/AuthScreen";

export const metadata = { title: "Create account" };
export default function SignUp() { return <AuthScreen initial="sign-up" />; }
