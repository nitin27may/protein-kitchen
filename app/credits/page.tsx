import { requirePageMember } from "@/lib/auth/access";
import { isCurator } from "@/lib/auth/curator";
import { optionalPageMember } from "@/lib/auth/public-access";
import type { Metadata } from "next";
import Link from "next/link";
import { CreditsList } from "@/components/photos/CreditsList";
import { PageTitle } from "@/components/ui";
import { creditsWithNames, libraryCredits } from "@/lib/library/anonymous";
import { libraryPhotoManifest } from "@/lib/library-photos/manifest";
import { photoReviewEnabled } from "@/lib/photos/review-flag";
import { getData } from "@/lib/server/context";
import { getCreditedPhotos } from "@/lib/server/queries";

export const metadata: Metadata = { title: "Photo credits" };
export const dynamic = "force-dynamic";

const CHANGES_NOTE = "Images were resized and converted to WebP for this site. No other changes were made.";

function Intro({ member }: { member: boolean }) {
  return (
    <>
      <PageTitle title="Photo credits" sub={member ? "Photos shared with everyone, plus those your household approved from Wikimedia Commons and Openverse. Your own photos are not listed." : "Photos shown on this site, from Wikimedia Commons and Openverse."} />
      <p className="px-4 pb-4 text-sm text-muted lg:px-2">{CHANGES_NOTE}</p>
    </>
  );
}

/** Credits for approved photos. Everyone sees the library's; a member also sees their household's own credited photos. */
export default async function CreditsPage() {
  const manifest = await libraryPhotoManifest();
  if (!await optionalPageMember()) {
    return (
      <>
        <Intro member={false} />
        <CreditsList rows={libraryCredits(getData(), manifest)} />
      </>
    );
  }
  const member = await requirePageMember();
  const rows = creditsWithNames(getData(), await getCreditedPhotos());
  const canReview = photoReviewEnabled() && await isCurator(member);
  return (
    <>
      <Intro member />
      {canReview ? <p className="px-4 pb-4 text-sm lg:px-2"><Link href="/photos/review" className="inline-flex min-h-11 items-center font-semibold text-primary underline">Review more photos</Link></p> : null}
      <CreditsList rows={rows} />
    </>
  );
}
