import { and, eq, gt, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import { requirePageMember, verifiedSessionUser } from "@/lib/auth/access";
import { getDb } from "@/lib/server/context";
import { householdInvitations, people } from "@/lib/db/schema";
import { AccountControls } from "@/components/auth/AccountControls";
import { LinkButton } from "@/components/ui";

export const metadata = { title: "Your account" };
export const dynamic = "force-dynamic";
export default async function Account() {
  const member = await requirePageMember();
  const user = await verifiedSessionUser();
  const db = await getDb();
  const [profile] = await db.select({ id: people.id, name: people.name }).from(people).where(eq(people.id, member.personId));
  if (!profile) redirect("/onboarding?next=%2Faccount");
  const owner = member.role === "owner";
  const profiles = owner ? await db.select({ id: people.id, name: people.name }).from(people) : [];
  const invitations = owner ? await db.select({ id: householdInvitations.id, email: householdInvitations.email })
    .from(householdInvitations).where(and(isNull(householdInvitations.acceptedAt), isNull(householdInvitations.revokedAt), gt(householdInvitations.expiresAt, new Date()))) : [];
  return <section className="mx-auto max-w-xl space-y-6 px-4 pb-28 pt-8">
    <h1 className="text-2xl font-bold">Your account</h1>
    <p className="break-words">{user.name} · {user.email}</p>
    <p className="capitalize">{member.role}</p>
    <div className="flex flex-wrap gap-3">
      <LinkButton href={`/profiles/${profile!.id}`} variant="secondary" className="max-w-full"><span className="min-w-0 truncate">Profile: {profile!.name}</span></LinkButton>
      <LinkButton href="/">Shared meal plan</LinkButton>
      <LinkButton href="/groceries" variant="secondary">Shared shopping list</LinkButton>
    </div>
    <AccountControls owner={owner} profiles={profiles} invitations={invitations} />
  </section>;
}
