"use client";

import { useId, useState } from "react";
import { scheduleUrl } from "@/lib/export/schedule-url";
import { Select } from "@/components/ui";

const link = "inline-flex min-h-11 items-center justify-center rounded-control px-4 text-base font-semibold lg:min-h-10 lg:text-[0.95rem]";

/** Opens the one-page fridge sheet in a new tab so a phone shows it in its PDF viewer. */
export function FridgeSchedule({ planId, people }: { planId: number; people: { id: number; name: string }[] }) {
  const selectId = useId();
  const [person, setPerson] = useState<number | null>(null);
  return (
    <div className="space-y-2 border-t border-line pt-3">
      <h3 className="text-sm font-semibold">Fridge schedule</h3>
      {people.length > 1 ? (
        <div>
          <label htmlFor={selectId} className="mb-1 block text-sm text-muted">Show portions for</label>
          <Select id={selectId} value={person ?? ""} onChange={(e) => setPerson(e.target.value === "" ? null : Number(e.target.value))}>
            <option value="">Everyone</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </div>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        <a href={scheduleUrl(planId, person)} target="_blank" rel="noopener" className={`${link} bg-primary text-primaryfg hover:opacity-90`}>Print schedule</a>
        <a href={scheduleUrl(planId, person, true)} className={`${link} border border-line bg-surface text-fg hover:bg-surface2`}>Download PDF</a>
      </div>
      <p className="text-sm text-muted">A4 landscape. Print at 100% scale.</p>
    </div>
  );
}
