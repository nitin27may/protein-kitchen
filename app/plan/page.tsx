import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { AnonymousPrompt } from "@/components/AnonymousPrompt";
import { optionalPageMember } from "@/lib/auth/public-access";
import { requirePageMember } from "@/lib/auth/access";

export const metadata: Metadata = { title: "Plan" };
export const dynamic = "force-dynamic";

export default async function PlanPage() {
  if (!await optionalPageMember()) {
    return <AnonymousPrompt title="Plan" sub="A week of high-protein vegetarian meals in about a minute." heading="No plan yet" body="Choose how many days and which meals, and the planner sizes each portion to a protein target. Sign in to open plans you saved." />;
  }
  await requirePageMember();
  redirect("/");
}
