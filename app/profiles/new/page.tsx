import type { Metadata } from "next";
import { ProfileForm } from "@/components/ProfileForm";
import { PageTitle } from "@/components/ui";

export const metadata: Metadata = { title: "New profile" };

export default async function NewProfile({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const nextHref = next && next.startsWith("/") && !next.startsWith("//") ? next : "/profiles";
  return (
    <>
      <PageTitle title="New profile" sub="Used to size portions and show nutrient targets." />
      <ProfileForm
        nextHref={nextHref}
        initial={{ name: "", sex: "male", birthDate: "", heightCm: "", weightKg: "", activityLevel: "moderate", proteinMode: "per_kg", proteinValue: 1.2, kcalTarget: "", reminderTime: "" }}
      />
    </>
  );
}
