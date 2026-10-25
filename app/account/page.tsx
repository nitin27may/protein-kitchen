import { redirect } from "next/navigation";
import { requirePageMember, verifiedSessionUser } from "@/lib/auth/access";
import { getDb } from "@/lib/server/context";
import { memberHouseholdAccess } from "@/lib/auth/household-access";
import { householdAccount } from "@/lib/server/household-account";
import { accountHasPassword } from "@/lib/auth/password";
import { PasswordControls } from "@/components/auth/PasswordControls";
import { AccountControls } from "@/components/auth/AccountControls";
import { LinkButton } from "@/components/ui";

export const metadata = { title: "Your account" };
export const dynamic = "force-dynamic";
export default async function Account() {
  const member = await requirePageMember();
  const user = await verifiedSessionUser();
  const db = await getDb();
  const access = await memberHouseholdAccess(db, member);
  const { profile, owner, invitations, incomingAssociations, members } = await householdAccount(db, access);
  if (!profile) redirect("/onboarding?next=%2Faccount");
  return <section className="mx-auto max-w-xl space-y-6 px-4 pb-28 pt-8">
    <h1 className="text-2xl font-bold">Your account</h1>
    <p className="break-words">{user.name} · {user.email}</p>
    <p className="capitalize">{member.role}</p>
    <div className="flex flex-wrap gap-3">
      <LinkButton href={`/profiles/${profile!.id}`} variant="secondary" className="max-w-full"><span className="min-w-0 truncate">Profile: {profile!.name}</span></LinkButton>
      <LinkButton href="/">Shared meal plan</LinkButton>
      <LinkButton href="/groceries" variant="secondary">Shared shopping list</LinkButton>
      <LinkButton href="/households" variant="secondary">Switch household</LinkButton>
    </div>
    <PasswordControls hasPassword={await accountHasPassword(db, member.userId)} />
    <AccountControls owner={owner} invitations={invitations} incomingAssociations={incomingAssociations}
      members={members} currentUserId={member.userId} />
  </section>;
}
