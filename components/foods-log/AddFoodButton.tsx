"use client";

import { useState } from "react";
import { PlusIcon } from "@/components/icons";
import { Button } from "@/components/ui";
import { useHydrated } from "@/lib/hooks/use-hydrated";
import { AddFoodSheet, type PersonChip } from "./AddFoodSheet";
import { useFoodLog } from "./FoodLogProvider";

/** "Add food" in the Today header, and "Add to lunch" under a slot. */
export function AddFoodButton({ label, variant = "secondary", slot, date, people, personId, today, yesterday, isOwner, className = "" }: {
  label: string;
  variant?: "primary" | "secondary" | "ghost";
  slot?: string;
  date?: string;
  people: PersonChip[];
  personId: number;
  today: string;
  yesterday: string;
  isOwner: boolean;
  className?: string;
}) {
  const hydrated = useHydrated();
  const { show, refresh } = useFoodLog();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} size="sm" className={className} disabled={!hydrated} onClick={() => setOpen(true)}><PlusIcon className="size-4" />{label}</Button>
      <AddFoodSheet open={open} onClose={() => setOpen(false)} mode={{ kind: "add" }} people={people} personId={personId} today={today} yesterday={yesterday}
        {...(slot ? { slot } : {})} {...(date ? { date } : {})} isOwner={isOwner}
        onDone={(r) => { show(r.message, r.undo); refresh(); }} />
    </>
  );
}
