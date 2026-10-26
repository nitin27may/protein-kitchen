import type { Metadata } from "next";
import Link from "next/link";
import { LinkButton } from "@/components/ui";

export const metadata: Metadata = { title: "Account deleted" };

/** Static confirmation shown after sign-out. It reads no session and no database. */
export default function AccountDeleted() {
  return <section className="mx-auto max-w-xl space-y-4 px-4 pb-28 pt-8">
    <h1 className="text-2xl font-bold">Your account has been deleted</h1>
    <p>You have been signed out on this device. If you were the only member of your household, the household and its data were deleted with your account.</p>
    <p>Copies can remain in database backups for up to 7 days. <Link href="/privacy#delete" className="font-semibold text-primary underline-offset-2 hover:underline">Read what is removed and what is kept</Link>.</p>
    <p>If you sign in again with the same email address, you get a new account and an empty kitchen.</p>
    <div className="flex flex-wrap gap-3">
      <LinkButton href="/recipes">Browse recipes</LinkButton>
      <LinkButton href="/sign-in" variant="secondary">Sign in</LinkButton>
    </div>
  </section>;
}
