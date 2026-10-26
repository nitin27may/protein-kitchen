"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { resetScope } from "@/app/actions";
import { Banner, Button, Field, Input } from "@/components/ui";
import type { ResetCounts } from "@/lib/server/reset";

type Scope = "plans" | "groceries" | "progress" | "ratings" | "profiles" | "all";

interface Option {
  scope: Scope;
  title: string;
  clears: string;
  keeps: string;
  count: (c: ResetCounts) => string;
  typed: boolean;
}

const OPTIONS: Option[] = [
  { scope: "plans", title: "Plans", clears: "All meal plans, their grocery ticks and manual items, prep ticks and next-step ticks.", keeps: "Profiles, ratings and favourites.", count: (c) => `${c.plans} saved, ${c.planSteps} next-step ticks`, typed: false },
  { scope: "groceries", title: "Grocery lists", clears: "Ticked items, items you added by hand and the pantry (what you have at home).", keeps: "Plans, profiles and ratings.", count: (c) => `${c.groceryItems} entries`, typed: false },
  { scope: "progress", title: "Daily habits and prep ticks", clears: "Habit check-offs, night-before prep ticks and reminder history.", keeps: "Plans, profiles and ratings.", count: (c) => `${c.progressTicks} ticks`, typed: false },
  { scope: "ratings", title: "Ratings and favourites", clears: "Star ratings, favourites, banned recipes, notes, and the tested flag. Every recipe goes back to draft.", keeps: "Plans, profiles and the recipes themselves.", count: (c) => `${c.ratings} recipes`, typed: false },
  { scope: "profiles", title: "Profiles", clears: "Every household profile, their likes and avoids, personal ratings, reminder subscriptions, habit history, and all household plans.", keeps: "Shared recipe history, account sign-ins and household membership.", count: (c) => `${c.profiles} people, ${c.plans} plans`, typed: true },
  { scope: "all", title: "Everything", clears: "All of the above, plus this household's recipe links, photos, saved views and daily routine choices.", keeps: "Account sign-ins, household membership and the recipe, ingredient and technique library.", count: () => "start from zero", typed: true },
];

export function SettingsClient({ counts }: { counts: ResetCounts }) {
  const router = useRouter();
  const [open, setOpen] = useState<Scope | null>(null);
  const [typed, setTyped] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [pending, start] = useTransition();

  const run = (o: Option) =>
    start(async () => {
      const r = await resetScope(o.scope, typed);
      if (r.ok) {
        setMsg({ tone: "ok", text: `${o.title} reset.${r.backup ? ` A backup of the database before the reset is in ${r.backup}.` : ""}` });
        setOpen(null);
        setTyped("");
        router.refresh();
      } else setMsg({ tone: "bad", text: r.error });
    });

  return (
    <section aria-labelledby="reset-h" className="space-y-3">
      <div>
        <h2 id="reset-h" className="text-lg font-semibold">Reset data</h2>
        <p className="mt-1 text-sm text-muted">Resets affect only this household. Reset is disabled until the operator has verified the backup and recovery procedure. The recipe and ingredient library is never deleted.</p>
      </div>
      {msg ? <Banner tone={msg.tone}>{msg.text}</Banner> : null}

      <ul className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
        {OPTIONS.map((o) => {
          const isOpen = open === o.scope;
          const ready = !o.typed || typed.trim() === "RESET";
          return (
            <li key={o.scope} className={`${o.scope === "all" ? "lg:col-span-2 " : ""}rounded-card border bg-surface p-4 ${o.scope === "all" ? "border-bad/50" : "border-line"}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-lg font-semibold">{o.title}</h3>
                <span className="text-sm text-muted tabular-nums">{o.count(counts)}</span>
              </div>
              <p className="mt-1 text-sm"><span className="font-semibold">Deletes: </span>{o.clears}</p>
              <p className="text-sm text-muted"><span className="font-semibold">Keeps: </span>{o.keeps}</p>

              {isOpen ? (
                <div className="mt-3 space-y-3 rounded-control border border-bad/40 bg-badsoft p-3">
                  <p className="text-sm font-semibold text-bad">This cannot be undone from the app.</p>
                  {o.typed ? (
                    <Field label="Type RESET to confirm" htmlFor={`confirm-${o.scope}`}>
                      <Input id={`confirm-${o.scope}`} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="characters" />
                    </Field>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button variant="danger" className="max-w-full whitespace-normal! text-center" disabled={!ready} loading={pending} onClick={() => run(o)}>{pending ? "Resetting" : `Reset ${o.title.toLowerCase()}`}</Button>
                    <Button variant="secondary" disabled={pending} onClick={() => { setOpen(null); setTyped(""); }}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <Button variant="danger" className="mt-3 max-w-full whitespace-normal! text-center" onClick={() => { setOpen(o.scope); setTyped(""); setMsg(null); }}>Reset {o.title.toLowerCase()}</Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
