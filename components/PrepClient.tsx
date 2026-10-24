"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { setPrepDone } from "@/app/actions";
import { ChevronDownIcon } from "@/components/icons";
import { Banner, Button, Card, Pill } from "@/components/ui";
import { round1, SLOT_LABEL } from "@/lib/format";

export interface PrepEventView {
  id: string;
  kind: "recipe" | "component";
  slug: string;
  name: string;
  cookDate: string;
  cookLabel: string;
  headline: string;
  useByLabel: string;
  covers: string[];
  activeMin: number;
  totalMin: number;
  passiveMin: number;
  startFirst: boolean;
  equipment: string[];
  ingredients: { name: string; grams: number }[];
  steps: { text: string; cue: string | null; tip: string | null }[];
  storage: string;
  done: boolean;
}

export interface PrepSessionView {
  date: string;
  label: string;
  activeMin: number;
  wallMin: number;
  equipment: string[];
  events: PrepEventView[];
}

export interface NightTask {
  key: string;
  dueDate: string;
  dueLabel: string;
  text: string;
  forName: string;
  done: boolean;
  today: boolean;
}

export interface EatView {
  date: string;
  label: string;
  meals: { slot: string; recipeSlug: string; name: string; mode: "batch" | "fresh"; note: string; activeMin: number }[];
}

export interface PrepProps {
  planId: number;
  rangeLabel: string;
  night: NightTask[];
  sessions: PrepSessionView[];
  eat: EatView[];
  freshCount: number;
}

const fmtG = (g: number) => (g < 10 ? `${round1(g)} g` : `${Math.round(g)} g`);
const minutes = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ""}`.trim() : `${m} min`);

export function PrepClient(p: PrepProps) {
  const [night, setNight] = useState(p.night);
  const [sessions, setSessions] = useState(p.sessions);
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [, start] = useTransition();

  function tickNight(key: string, date: string, done: boolean) {
    setNight((c) => c.map((t) => (t.key === key ? { ...t, done } : t)));
    start(async () => {
      const r = await setPrepDone(date, key, done);
      if (!r.ok) {
        setNight((c) => c.map((t) => (t.key === key ? { ...t, done: !done } : t)));
        setNote({ tone: "bad", text: r.error });
      }
    });
  }

  function tickEvent(sessionDate: string, id: string, done: boolean) {
    const key = `prep:${p.planId}:${id}`;
    setSessions((c) => c.map((s) => (s.date === sessionDate ? { ...s, events: s.events.map((e) => (e.id === id ? { ...e, done } : e)) } : s)));
    start(async () => {
      const r = await setPrepDone(sessionDate, key, done);
      if (!r.ok) {
        setSessions((c) => c.map((s) => (s.date === sessionDate ? { ...s, events: s.events.map((e) => (e.id === id ? { ...e, done: !done } : e)) } : s)));
        setNote({ tone: "bad", text: r.error });
      }
    });
  }

  async function copy() {
    const lines: string[] = [];
    if (night.length) {
      lines.push("Night before");
      for (const t of night) lines.push(`- ${t.dueLabel}: ${t.text} (${t.forName})`);
      lines.push("");
    }
    for (const s of sessions) {
      lines.push(`${s.label} (about ${minutes(s.wallMin)})`);
      s.events.forEach((e, i) => lines.push(`${i + 1}. ${e.name}: ${e.headline}. Use by ${e.useByLabel}`));
      lines.push("");
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n").trim());
      setNote({ tone: "ok", text: "Copied the prep checklist." });
    } catch {
      setNote({ tone: "bad", text: "Could not copy. Long-press the page and copy by hand." });
    }
  }

  const totalActive = sessions.reduce((a, s) => a + s.activeMin, 0);

  return (
    <div className="space-y-5 px-4 pb-8 pt-2 lg:px-4">
      <p className="text-sm text-muted">{p.rangeLabel}</p>

      <Card className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4">
        <dl className="flex flex-wrap gap-x-8 gap-y-3">
          <div><dt className="text-sm text-muted">Batch {sessions.length === 1 ? "session" : "sessions"}</dt><dd className="font-display text-3xl font-bold tabular-nums">{sessions.length}</dd></div>
          <div><dt className="text-sm text-muted">Hands-on cooking</dt><dd className="font-display text-3xl font-bold tabular-nums">{minutes(totalActive)}</dd></div>
          <div><dt className="text-sm text-muted">Night-before {night.length === 1 ? "task" : "tasks"}</dt><dd className="font-display text-3xl font-bold tabular-nums">{night.length}</dd></div>
          <div><dt className="text-sm text-muted">Cooked fresh</dt><dd className="font-display text-3xl font-bold tabular-nums">{p.freshCount}</dd></div>
        </dl>
        <div className="space-y-1">
          <Button variant="secondary" onClick={copy}>Copy checklist</Button>
        </div>
        <p className="w-full text-sm text-muted">Fresh meals are cooked on the day because they do not keep or are only eaten once.</p>
      </Card>

      {note ? <Banner tone={note.tone}>{note.text}</Banner> : null}

      <div className="space-y-5 lg:grid lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start lg:gap-6 lg:space-y-0">
      <div className="space-y-5 lg:sticky lg:top-4">

      <section aria-labelledby="night">
        <h2 id="night" className="mb-2 text-lg font-semibold">Night before <span className="text-sm font-normal text-muted tabular-nums">{night.filter((t) => t.done).length} of {night.length} done</span></h2>
        {night.length === 0 ? (
          <p className="rounded-card border border-dashed border-line p-4 text-sm text-muted">Nothing to soak, marinate or set ahead for this plan.</p>
        ) : (
          <ul className="divide-y divide-line rounded-card border border-line bg-surface">
            {night.map((t) => (
              <li key={t.key} className={t.done ? "bg-surface2/60" : ""}>
                <label className="flex min-h-14 cursor-pointer items-center gap-3 px-3 py-2">
                  <input type="checkbox" checked={t.done} onChange={(e) => tickNight(t.key, t.dueDate, e.target.checked)} className="size-6 shrink-0 accent-[var(--primary)]" />
                  <span className="min-w-0 flex-1">
                    <span className={`block text-base ${t.done ? "text-muted line-through" : "font-medium"}`}>{t.text}</span>
                    <span className="block text-xs text-muted">for {t.forName}</span>
                  </span>
                  <span className="shrink-0 text-right text-sm">{t.today ? <Pill tone="warn">Tonight</Pill> : <span className="text-muted">{t.dueLabel}</span>}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </section>
      </div>

      <div className="space-y-6">
      {sessions.map((s) => (
        <section key={s.date} aria-labelledby={`s-${s.date}`}>
          <h2 id={`s-${s.date}`} className="text-lg font-semibold">{s.label}</h2>
          <p className="mb-2 text-sm text-muted">
            About {minutes(s.wallMin)} if you run jobs in parallel · {minutes(s.activeMin)} hands-on{s.equipment.length ? ` · uses ${s.equipment.join(", ")}` : ""}
          </p>
          <ol className="space-y-3">
            {s.events.map((e, i) => (
              <li key={e.id} className={`overflow-hidden rounded-card border bg-surface ${e.done ? "border-ok/50" : "border-line"}`}>
                <div className="flex gap-3 p-3">
                  <label className="flex size-11 shrink-0 cursor-pointer items-center justify-center">
                    <input type="checkbox" aria-label={`Mark ${e.name} done`} checked={e.done} onChange={(ev) => tickEvent(s.date, e.id, ev.target.checked)} className="size-6 accent-[var(--primary)]" />
                  </label>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primarysoft text-sm font-bold text-primary" aria-hidden="true">{i + 1}</span>
                      <Link href={`/recipes/${e.slug}`} className={`inline-flex min-h-11 items-center text-lg font-semibold leading-snug hover:underline ${e.done ? "text-muted line-through" : ""}`}>{e.name}</Link>
                      {e.startFirst ? <Pill tone="warn">Start first</Pill> : null}
                      {e.kind === "component" ? <Pill>Sauce or dressing</Pill> : null}
                    </div>
                    <p className="mt-1 text-base">{e.headline}</p>
                    <p className="text-sm text-muted">{minutes(e.activeMin)} hands-on · {minutes(e.totalMin)} total{e.passiveMin >= 20 ? ` · ${minutes(e.passiveMin)} unattended` : ""}</p>
                    <p className="text-sm"><span className="font-semibold">Use by {e.useByLabel}.</span> <span className="text-muted">Feeds {e.covers.join(", ")}.</span></p>
                  </div>
                </div>
                <button type="button" aria-expanded={open === e.id} onClick={() => setOpen(open === e.id ? null : e.id)} className="flex min-h-11 w-full items-center justify-between border-t border-line px-4 text-base font-semibold text-primary hover:bg-primarysoft">
                  {open === e.id ? "Hide the steps" : "Show ingredients and steps"} <ChevronDownIcon className={`size-5 transition-transform ${open === e.id ? "rotate-180" : ""}`} />
                </button>
                {open === e.id ? (
                  <div className="space-y-4 border-t border-line p-4">
                    <div>
                      <h3 className="mb-1 text-base font-semibold">Ingredients for this batch</h3>
                      <ul className="divide-y divide-line">
                        {e.ingredients.map((g) => (<li key={g.name} className="flex justify-between gap-3 py-1.5 text-base"><span>{g.name}</span><span className="font-semibold tabular-nums">{fmtG(g.grams)}</span></li>))}
                      </ul>
                    </div>
                    <div>
                      <h3 className="mb-1 text-base font-semibold">Steps</h3>
                      <ol className="space-y-3">
                        {e.steps.map((st, k) => (
                          <li key={k} className="flex gap-3">
                            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primarysoft text-xs font-bold text-primary">{k + 1}</span>
                            <div>
                              <p className="text-base leading-relaxed">{st.text}</p>
                              {st.cue ? <p className="mt-0.5 text-sm"><span className="font-semibold text-ok">Done when: </span>{st.cue}</p> : null}
                              {st.tip ? <p className="mt-0.5 text-sm text-muted"><span className="font-semibold text-fg">Tip: </span>{st.tip}</p> : null}
                            </div>
                          </li>
                        ))}
                      </ol>
                      <p className="mt-2 text-sm text-muted">Quantities above are for the whole batch. The step quantities are for the recipe as written, so scale them by the batch size.</p>
                    </div>
                    <div>
                      <h3 className="mb-1 text-base font-semibold">Store and reheat</h3>
                      <p className="text-base leading-relaxed">{e.storage}</p>
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
          <Banner tone="info" title="Finish the session">
            Cool everything within 2 hours, then portion into airtight containers and label each with the date and its use-by day. Hot food sealed in a container spoils faster.
          </Banner>
        </section>
      ))}

      <section aria-labelledby="days">
        <h2 id="days" className="mb-2 text-lg font-semibold">Day by day</h2>
        <ul className="grid gap-3 md:grid-cols-2">
          {p.eat.map((d) => (
            <li key={d.date} className="rounded-card border border-line bg-surface p-3">
              <h3 className="text-base font-semibold">{d.label}</h3>
              <ul className="mt-1 divide-y divide-line">
                {d.meals.map((m) => (
                  <li key={`${m.slot}-${m.recipeSlug}`} className="flex items-start justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-primary">{SLOT_LABEL[m.slot] ?? m.slot}</p>
                      <Link href={`/recipes/${m.recipeSlug}`} className="inline-flex min-h-11 items-center text-base font-medium hover:underline">{m.name}</Link>
                      <p className="text-sm text-muted">{m.note}</p>
                    </div>
                    <Pill tone={m.mode === "batch" ? "ok" : "info"}>{m.mode === "batch" ? "Reheat" : `Cook · ${m.activeMin} min`}</Pill>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </section>
      </div>
      </div>
    </div>
  );
}
