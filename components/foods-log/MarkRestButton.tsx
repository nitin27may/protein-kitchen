"use client";

import { useState } from "react";
import { markRestOfDayEaten } from "@/app/foods/log-actions";
import { Button } from "@/components/ui";
import { useHydrated } from "@/lib/hooks/use-hydrated";
import { useFoodLog } from "./FoodLogProvider";

export function MarkRestButton({ personId, planId, date, pending, dayWord }: { personId: number; planId: number; date: string; pending: number; dayWord: string }) {
  const hydrated = useHydrated();
  const { show, refresh } = useFoodLog();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (pending === 0) return null;
  async function run() {
    setBusy(true); setError(null);
    const res = await markRestOfDayEaten({ personId, planId, date });
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    show(res.marked === 1 ? "Marked 1 meal as eaten." : `Marked ${res.marked} meals as eaten.`);
    refresh();
  }
  return (
    <div>
      <Button variant="secondary" className="w-full" disabled={!hydrated} loading={busy} onClick={() => void run()}>Mark the rest of {dayWord} as eaten as planned</Button>
      {error ? <p role="alert" className="mt-1 text-sm text-bad">{error}</p> : null}
    </div>
  );
}
