import { AuthScreen } from "@/components/auth/AuthScreen";

export const metadata = { title: "Reset password" };
export default function ResetPassword() { return <AuthScreen initial="reset" />; }
