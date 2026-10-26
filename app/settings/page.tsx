import { requirePageMember } from "@/lib/auth/access";
import type { Metadata } from "next";
import Link from "next/link";
import { ThemeToggle } from "@/components/ThemeToggle";
import { SettingsClient } from "@/components/SettingsClient";
import { PageTitle } from "@/components/ui";
import { getResetCounts } from "@/lib/server/queries";
import { photoReviewEnabled } from "@/lib/photos/review-flag";
import { StateSyncControls } from "@/components/StateSyncControls";
import { stateSyncSettings } from "@/lib/sync/server";
import { LegacyImportPanel } from "@/components/LegacyImportPanel";
import { legacyImportEnabled } from "@/lib/human/legacy-household-import";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const member = await requirePageMember();
  const counts = await getResetCounts();
  const sync = member.role === "owner" ? await stateSyncSettings() : null;
  return (
    <>
      <PageTitle title="Settings" sub="Manage people and start over when you want to." />
      <div className="mx-auto max-w-6xl space-y-6 px-4 pb-10">
        <Link href="/profiles" className="block rounded-card border border-line bg-surface p-4 transition-colors hover:border-primary">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-lg font-semibold">Profiles</h2>
            <span className="text-sm font-semibold text-primary">Open</span>
          </div>
          <p className="mt-1 text-sm text-muted">People, protein targets, likes and avoids, and reminders. {counts.profiles} {counts.profiles === 1 ? "person" : "people"} saved.</p>
        </Link>
        {photoReviewEnabled() ? (
          <Link href="/photos/review" className="block rounded-card border border-line bg-surface p-4 transition-colors hover:border-primary">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-lg font-semibold">Photos</h2>
              <span className="text-sm font-semibold text-primary">Review</span>
            </div>
            <p className="mt-1 text-sm text-muted">Approve or reject candidate photos for recipes and ingredients. {counts.photos} {counts.photos === 1 ? "photo" : "photos"} kept.</p>
          </Link>
        ) : (
          <section className="rounded-card border border-line bg-surface p-4">
            <h2 className="text-lg font-semibold">Photos</h2>
            <p className="mt-1 text-sm text-muted">{counts.photos} {counts.photos === 1 ? "photo" : "photos"} kept. Add your own on a recipe page.</p>
          </section>
        )}
        <section className="space-y-2 rounded-card border border-line bg-surface p-4">
          <h2 className="text-lg font-semibold">Colour theme</h2>
          <p className="text-sm text-muted">Auto follows your device.</p>
          <div className="max-w-sm"><ThemeToggle variant="segmented" /></div>
        </section>
        {sync ? <StateSyncControls settings={sync} /> : null}
        {member.role === "owner" && legacyImportEnabled() ? <LegacyImportPanel /> : null}
        <SettingsClient counts={counts} />
      </div>
    </>
  );
}
