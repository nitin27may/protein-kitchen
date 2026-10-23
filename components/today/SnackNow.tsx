"use client";

import Link from "next/link";
import { useState } from "react";
import { Sheet } from "@/components/Sheet";
import { Button, Chip, MacroLine, Pill } from "@/components/ui";
import type { SnackView } from "./types";

export function SnackNow({ snacks }: { snacks: Record<"0" | "5" | "10", SnackView[]> }) {
  const [open, setOpen] = useState(false);
  const [bucket, setBucket] = useState<"0" | "5" | "10">("5");
  return (
    <>
      <Button size="lg" variant="secondary" className="w-full" onClick={() => setOpen(true)}>Snack now</Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Snack now">
        <div className="space-y-3 p-4">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Time available">
            {(["0", "5", "10"] as const).map((b) => (
              <Chip key={b} on={bucket === b} onClick={() => setBucket(b)}>{b === "0" ? "No cooking" : `${b} min`}</Chip>
            ))}
          </div>
          <p className="text-sm text-muted">Ideas only. Picking one does not change your plan or log anything.</p>
          <ul className="space-y-2">
            {snacks[bucket].length === 0 ? <li className="rounded-card border border-dashed border-line p-4 text-center text-muted">No snack of 10 g protein or more fits that time yet.</li> : null}
            {snacks[bucket].map((s) => (
              <li key={s.slug} className="rounded-card border border-strong p-3">
                <Link href={`/recipes/${s.slug}`} className="text-base font-semibold hover:underline">{s.name}</Link>
                <MacroLine protein={s.proteinG} kcal={s.kcal} minutes={s.minutes} />
                <Pill tone={s.needsCooking ? "warn" : "ok"}>{s.needsCooking ? "Needs cooking" : "No cooking"}</Pill>
              </li>
            ))}
          </ul>
        </div>
      </Sheet>
    </>
  );
}
