"use client";

import { useState } from "react";
import { deleteEntry, markMealEaten, markMealSkipped } from "@/app/foods/log-actions";
import { CheckIcon } from "@/components/icons";
import { Button } from "@/components/ui";
import { useHydrated } from "@/lib/hooks/use-hydrated";
import type { MealStatus } from "@/lib/food-log/day-view";
import { AddFoodSheet, type PersonChip } from "./AddFoodSheet";
import { useFoodLog } from "./FoodLogProvider";

export interface MealLogProps {
  personId: number;
  planSlotId: number;
  mealName: string;
  /** Whether the plan slot was already locked before this session. */
  locked: boolean;
  status: MealStatus;
  entryUid: string | null;
  /** What was eaten instead, for a swapped meal. */
  answerLabel: string | null;
  people: PersonChip[];
  today: string;
  yesterday: string;
  isOwner: boolean;
}

/** Ate it, Swapped, Skipped for one planned meal; once answered, the answer and a Change button. */
export function MealLogButtons(p: MealLogProps) {
  const hydrated = useHydrated();
  const { show, refresh } = useFoodLog();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [swapOpen, setSwapOpen] = useState(false);

  const undoer = (uid: string) => async () => {
    const res = await deleteEntry({ personId: p.personId, uid, ...(p.locked ? {} : { unlockSlotId: p.planSlotId }) });
    return res.ok ? null : res.error;
  };

  async function answer(kind: "eaten" | "skipped") {
    setBusy(kind); setError(null);
    const res = kind === "eaten" ? await markMealEaten({ personId: p.personId, planSlotId: p.planSlotId }) : await markMealSkipped({ personId: p.personId, planSlotId: p.planSlotId });
    setBusy(null);
    if (!res.ok) { setError(res.error); return; }
    show(kind === "eaten" ? `Marked ${p.mealName} as eaten.` : `Skipped ${p.mealName}.`, undoer(res.uid));
    refresh();
  }

  async function change() {
    if (!p.entryUid) return;
    setBusy("change"); setError(null);
    const res = await deleteEntry({ personId: p.personId, uid: p.entryUid });
    setBusy(null);
    if (!res.ok) { setError(res.error); return; }
    refresh();
  }

  if (p.status !== "pending") {
    const text = p.status === "eaten" ? "Ate it" : p.status === "swapped" ? `Swapped for ${p.answerLabel ?? "something else"}` : "Skipped";
    return (
      <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-1" data-testid="meal-status">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-ok"><CheckIcon className="size-4" />{text}</p>
        <Button variant="ghost" size="sm" disabled={!hydrated} loading={busy === "change"} onClick={() => void change()}>Change</Button>
        {error ? <p role="alert" className="basis-full text-sm text-bad">{error}</p> : null}
      </div>
    );
  }
  return (
    <div className="border-t border-line p-2">
      <div className="grid grid-cols-3 gap-2">
        <Button variant="secondary" size="sm" disabled={!hydrated || busy !== null} loading={busy === "eaten"} onClick={() => void answer("eaten")}>Ate it</Button>
        <Button variant="secondary" size="sm" disabled={!hydrated || busy !== null} onClick={() => setSwapOpen(true)}>Swapped</Button>
        <Button variant="secondary" size="sm" disabled={!hydrated || busy !== null} loading={busy === "skipped"} onClick={() => void answer("skipped")}>Skipped</Button>
      </div>
      {error ? <p role="alert" className="mt-2 text-sm text-bad">{error}</p> : null}
      <AddFoodSheet open={swapOpen} onClose={() => setSwapOpen(false)} mode={{ kind: "swap", planSlotId: p.planSlotId, plannedName: p.mealName, locked: p.locked }}
        people={p.people} personId={p.personId} today={p.today} yesterday={p.yesterday} isOwner={p.isOwner}
        onDone={(r) => { show(r.message, r.undo); refresh(); }} />
    </div>
  );
}
