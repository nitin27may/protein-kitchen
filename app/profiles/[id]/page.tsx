import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProfileForm } from "@/components/ProfileForm";
import { PageTitle } from "@/components/ui";
import { getPerson } from "@/lib/server/queries";

export const metadata: Metadata = { title: "Edit profile" };
export const dynamic = "force-dynamic";

export default async function EditProfile({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = Number.isInteger(Number(id)) ? await getPerson(Number(id)) : undefined;
  if (!p) notFound();
  return (
    <>
      <PageTitle title={p.name} sub="Edit this profile" />
      <ProfileForm
        vapidPublicKey={process.env.VAPID_PUBLIC_KEY ?? null}
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
        }}
      />
    </>
  );
}
