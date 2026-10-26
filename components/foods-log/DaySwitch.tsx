import Link from "next/link";

/** Today shows today; one link steps back to yesterday to log or review it, and one steps forward again. */
export function DaySwitch({ viewingYesterday, yesterdayHref, todayHref }: { viewingYesterday: boolean; yesterdayHref: string; todayHref: string }) {
  return (
    <nav aria-label="Day" className="flex gap-2 px-4 pb-2">
      <Link href={yesterdayHref} aria-current={viewingYesterday ? "page" : undefined}
        className={`inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-semibold lg:min-h-9 ${viewingYesterday ? "border-primary bg-primarysoft text-primary" : "border-strong bg-surface hover:bg-surface2"}`}>Yesterday</Link>
      <Link href={todayHref} aria-current={viewingYesterday ? undefined : "page"}
        className={`inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-semibold lg:min-h-9 ${viewingYesterday ? "border-strong bg-surface hover:bg-surface2" : "border-primary bg-primarysoft text-primary"}`}>Today</Link>
    </nav>
  );
}
