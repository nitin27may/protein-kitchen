import { requirePageMember } from "@/lib/auth/access";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProfileForm } from "@/components/ProfileForm";
import { PageTitle } from "@/components/ui";
import { getRoutineCatalog } from "@/lib/routines/catalog";
import { getData } from "@/lib/server/context";
import { getPerson, getPersonRoutines } from "@/lib/server/queries";

export const metadata: Metadata = { title: "Edit profile" };
export const dynamic = "force-dynamic";

export default async function EditProfile({ params }: { params: Promise<{ id: string }> }) {
  const member = await requirePageMember({ personId: Number((await params).id) });
  const { id } = await params;
  const p = Number.isInteger(Number(id)) ? await getPerson(Number(id)) : undefined;
  if (!p) notFound();
  const catalog = getRoutineCatalog(getData());
  const chosen = await getPersonRoutines(p.id);
  return (
    <>
      <PageTitle title={p.name} sub="Edit this profile" />
      <ProfileForm
        canDelete={member.role === "owner" && member.personId !== p.id}
        deviceReminders={member.personId === p.id}
        vapidPublicKey={process.env.VAPID_PUBLIC_KEY ?? null}
        routines={{ catalog, chosen }}
        initial={{
          id: p.id,
          name: p.name,
          sex: p.sex,
          birthDate: p.birthDate,
          heightCm: p.heightCm,
          weightKg: p.weightKg,
          activityLevel: p.activityLevel,
          proteinMode: p.proteinTargetG ? "fixed" : "per_kg",
          proteinValue: p.proteinTargetG ?? p.proteinGPerKg ?? 1.2,
          kcalTarget: p.kcalTarget ?? "",
          reminderTime: p.reminderTime ?? "",
          reminderTimezone: p.reminderTimezone ?? "",
        }}
      />
    </>
  );
}
