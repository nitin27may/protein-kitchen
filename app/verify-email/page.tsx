import { AuthScreen } from "@/components/auth/AuthScreen";

export const metadata = { title: "Verify email" };
export default function VerifyEmail() { return <AuthScreen initial="verify" />; }
