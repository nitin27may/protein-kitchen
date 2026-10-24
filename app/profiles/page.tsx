import { requirePageMember } from "@/lib/auth/access";
import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState, LinkButton, PageTitle } from "@/components/ui";
import { ageFrom } from "@/lib/format";
import { proteinTargetOf } from "@/lib/server/queries";
import { getDb } from "@/lib/server/context";
import { resolveOnlyHouseholdAccess } from "@/lib/auth/household-access";
import { householdPeople } from "@/lib/server/household-plans";

export const metadata: Metadata = { title: "Profiles" };
export const dynamic = "force-dynamic";

export default async function ProfilesPage() {
  const member = await requirePageMember();
  const db = await getDb();
  const access = await resolveOnlyHouseholdAccess(db, member.userId);
  const people = (await householdPeople(db, access)).filter((p) => access.role === "owner" || p.id === access.personId);
  return (
    <>
      <PageTitle title="Profiles" sub="Each person has their own targets, likes and portions." action={people.length && member.role === "owner" ? <LinkButton href="/profiles/new">Add person</LinkButton> : undefined} />
      {people.length === 0 ? (
        <EmptyState title="No profiles yet" body="Add the first person so plans can be sized to their protein target." action={<LinkButton href="/profiles/new?next=/plan/new">Add a profile</LinkButton>} />
      ) : (
        <ul className="grid gap-3 px-4 pb-6 sm:grid-cols-2 lg:grid-cols-3 lg:px-2">
          {people.map((p) => (
            <li key={p.id}>
              <Link href={`/profiles/${p.id}`} className="group flex h-full flex-col rounded-card border border-line bg-surface p-4 transition-colors hover:border-primary">
                <div className="flex items-center gap-3">
                  <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primarysoft font-display text-xl font-bold text-primary" aria-hidden="true">{p.name.trim().charAt(0).toUpperCase()}</span>
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-lg font-semibold">{p.name}</h2>
                    <p className="text-sm text-muted tabular-nums">{ageFrom(p.birthDate)} y, {Math.round(p.heightCm)} cm, {p.weightKg} kg</p>
                  </div>
                  <span className="text-sm font-semibold text-primary group-hover:underline">Edit</span>
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-2 border-t border-line pt-3">
                  <div><dt className="text-sm text-muted">Protein a day</dt><dd className="font-display text-2xl font-bold tabular-nums">{proteinTargetOf(p)} g</dd></div>
                  <div><dt className="text-sm text-muted">Calories</dt><dd className="font-display text-2xl font-bold tabular-nums">{p.kcalTarget ?? "--"}</dd></div>
                </dl>
                <p className="mt-2 text-sm text-muted">{p.reminderTime ? `Prep reminder at ${p.reminderTime} (${p.reminderTimezone || "household time"})` : "No prep reminder"}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
