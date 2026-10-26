import Link from "next/link";
import { AddFoodButton } from "@/components/foods-log/AddFoodButton";
import type { PersonChip } from "@/components/foods-log/AddFoodSheet";
import { EntryRow } from "@/components/foods-log/EntryRow";
import { MarkRestButton } from "@/components/foods-log/MarkRestButton";
import { MealLogButtons } from "@/components/foods-log/MealLogButtons";
import { RecipeThumb } from "@/components/RecipeThumb";
import { MacroLine } from "@/components/ui";
import type { EntryView } from "@/lib/food-log/day-view";
import { SLOT_LABEL } from "@/lib/format";
import type { MealView } from "./types";

const SLOT_ORDER = ["breakfast", "lunch", "dinner", "snack", "shake"];

/** The food log for the shown day: who it is for, what is already eaten, and what the buttons need. */
export interface DayLog {
  personId: number;
  date: string;
  today: string;
  yesterday: string;
  /** False for a day that has not happened yet: nothing can be eaten on it. */
  canLog: boolean;
  isOwner: boolean;
  people: PersonChip[];
  /** Extras and swaps for the person on this day. */
  entries: EntryView[];
  status: "logged" | "not_logged" | "open";
  pendingCount: number;
  dayWord: string;
}

/** `planId` carries the plan into the recipe page so Make / Buy / Have choices for parts are saved to it. */
export function MealsToday({ title, meals, planId, log }: { title: string; meals: MealView[]; planId?: number | null; log?: DayLog }) {
  const extras = (slot: string) => (log?.entries ?? []).filter((e) => e.kind === "extra" && e.slot === slot);
  const slots = SLOT_ORDER.filter((slot) => meals.some((m) => m.slot === slot) || extras(slot).length > 0);
  if (slots.length === 0) {
    return (
      <section aria-labelledby="meals-h">
        <h2 id="meals-h" className="mb-2 text-lg font-semibold">{title}</h2>
        <p className="px-1 text-sm text-muted">{log?.status === "not_logged" ? "Not logged. Nothing was planned for this day." : "No meals planned for this day."}</p>
      </section>
    );
  }
  return (
    <section aria-labelledby="meals-h" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="meals-h" className="text-lg font-semibold">{title}</h2>
        {log?.status === "not_logged" ? <p className="rounded-full border border-line px-3 py-1 text-sm font-semibold text-muted">Not logged</p> : null}
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {slots.map((slot) => {
          const m = meals.find((x) => x.slot === slot);
          const more = extras(slot);
          return (
            <li key={slot} className="flex flex-col overflow-hidden rounded-card border border-line bg-surface" data-slot={slot}>
              {m ? (
                <>
                  <Link href={planId ? `/recipes/${m.slug}?plan=${planId}` : `/recipes/${m.slug}`} className="flex flex-1 hover:bg-surface2/50 sm:flex-col">
                    <RecipeThumb image={m.image} thumbs={m.thumbs} label={SLOT_LABEL[m.slot] ?? m.slot} className="aspect-[4/3] w-28 shrink-0 sm:aspect-[16/9] sm:w-full" />
                    <div className="min-w-0 flex-1 p-3">
                      <p className="text-sm font-semibold text-primary">{SLOT_LABEL[m.slot] ?? m.slot}</p>
                      <p className="text-base font-semibold leading-snug">{m.name}</p>
                      <MacroLine protein={m.proteinG} kcal={m.kcal} minutes={m.leftover ? undefined : m.activeMin} />
                      {m.leftover ? <p className="mt-1 text-sm text-muted">Leftover, no cooking</p> : null}
                    </div>
                  </Link>
                  {log && log.canLog && m.log ? (
                    <MealLogButtons personId={log.personId} planSlotId={m.id} mealName={m.name} locked={m.log.locked} status={m.log.status} entryUid={m.log.entryUid}
                      answerLabel={m.log.answerLabel} people={log.people} today={log.today} yesterday={log.yesterday} isOwner={log.isOwner} />
                  ) : null}
                </>
              ) : (
                <p className="px-3 pt-3 text-sm font-semibold text-primary">{SLOT_LABEL[slot] ?? slot}</p>
              )}
              {more.length ? (
                <ul className="divide-y divide-line border-t border-line" aria-label={`Also eaten at ${(SLOT_LABEL[slot] ?? slot).toLowerCase()}`}>
                  {more.map((e) => <EntryRow key={e.uid} entry={e} canEdit={!!log?.canLog} />)}
                </ul>
              ) : null}
              {log && log.canLog ? (
                <div className="border-t border-line p-2">
                  <AddFoodButton label={`Add to ${(SLOT_LABEL[slot] ?? slot).toLowerCase()}`} variant="ghost" slot={slot} date={log.date} people={log.people} personId={log.personId}
                    today={log.today} yesterday={log.yesterday} isOwner={log.isOwner} className="w-full" />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {log && log.canLog && planId ? <MarkRestButton personId={log.personId} planId={planId} date={log.date} pending={log.pendingCount} dayWord={log.dayWord} /> : null}
    </section>
  );
}
