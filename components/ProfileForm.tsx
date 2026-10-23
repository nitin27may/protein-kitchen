"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deletePerson, savePerson } from "@/app/actions";
import { ReminderSettings } from "@/components/ReminderSettings";
import { Banner, Button, Chip, ChoiceCard, Field, Input, SectionCard, Segmented } from "@/components/ui";

export interface ProfileInitial {
  id?: number;
  name: string;
  sex: "male" | "female" | "other";
  birthDate: string;
  heightCm: number | "";
  weightKg: number | "";
  activityLevel: "sedentary" | "light" | "moderate" | "high";
  proteinMode: "per_kg" | "fixed";
  proteinValue: number | "";
  kcalTarget: number | "";
  reminderTime: string;
}

const ACTIVITY: { value: ProfileInitial["activityLevel"]; label: string; hint: string }[] = [
  { value: "sedentary", label: "Mostly sitting", hint: "Desk job, little exercise" },
  { value: "light", label: "Light", hint: "Walks, 1 to 2 workouts a week" },
  { value: "moderate", label: "Moderate", hint: "3 to 4 workouts a week" },
  { value: "high", label: "High", hint: "5 or more hard sessions a week" },
];

const PRESETS = [
  { label: "Minimum 0.8", value: 0.8, hint: "Avoids deficiency, not a training target" },
  { label: "Active 1.2", value: 1.2, hint: "Common for regular exercise" },
  { label: "Building 1.6", value: 1.6, hint: "Upper end for muscle gain" },
];

function feetInches(cm: number): string {
  const totalIn = cm / 2.54;
  const ft = Math.floor(totalIn / 12);
  const inch = Math.round(totalIn - ft * 12);
  return inch === 12 ? `${ft + 1} ft 0 in` : `${ft} ft ${inch} in`;
}

export function ProfileForm({ initial, nextHref = "/profiles", vapidPublicKey = null }: { initial: ProfileInitial; nextHref?: string; vapidPublicKey?: string | null }) {
  const router = useRouter();
  const [v, setV] = useState<ProfileInitial>(initial);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const set = <K extends keyof ProfileInitial>(k: K, val: ProfileInitial[K]) => setV((p) => ({ ...p, [k]: val }));
  const num = (s: string): number | "" => (s === "" ? "" : Number(s));

  const dailyProtein =
    v.proteinValue === "" ? null : v.proteinMode === "per_kg" ? (v.weightKg === "" ? null : Math.round(v.proteinValue * v.weightKg)) : Math.round(v.proteinValue);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setFields({});
    start(async () => {
      const res = await savePerson({
        id: v.id,
        name: v.name,
        sex: v.sex,
        birthDate: v.birthDate,
        heightCm: v.heightCm === "" ? Number.NaN : v.heightCm,
        weightKg: v.weightKg === "" ? Number.NaN : v.weightKg,
        activityLevel: v.activityLevel,
        proteinMode: v.proteinMode,
        proteinValue: v.proteinValue === "" ? Number.NaN : v.proteinValue,
        kcalTarget: v.kcalTarget === "" ? null : v.kcalTarget,
        reminderTime: v.reminderTime === "" ? null : v.reminderTime,
      });
      if (!res.ok) {
        setError(res.error);
        setFields(res.fields ?? {});
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      router.push(nextHref);
      router.refresh();
    });
  }

  function remove() {
    if (!v.id) return;
    start(async () => {
      const res = await deletePerson(v.id!);
      if (!res.ok) {
        setError(res.error);
        setConfirmDelete(false);
        return;
      }
      router.push("/profiles");
      router.refresh();
    });
  }

  const perKg = dailyProtein !== null && typeof v.weightKg === "number" && v.weightKg > 0 ? Math.round((dailyProtein / v.weightKg) * 10) / 10 : null;
  const activityLabel = ACTIVITY.find((a) => a.value === v.activityLevel)?.label ?? "";
  const saveLabel = v.id ? "Save changes" : "Save profile";

  return (
    <form onSubmit={submit} className="px-4 pb-28 pt-2 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-6 lg:pb-10" noValidate>
      <div className="space-y-4">
        {error ? <Banner tone="bad" title="Could not save">{error}</Banner> : null}

        <SectionCard id="body" title="About" description="Used to size portions and to pick nutrient targets.">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field label="Name" htmlFor="name" error={fields.name}>
                <Input id="name" value={v.name} onChange={(e) => set("name", e.target.value)} autoComplete="given-name" required aria-invalid={!!fields.name} aria-describedby={fields.name ? "name-err" : undefined} />
              </Field>
            </div>
            <div>
              <p className="mb-1 text-sm font-semibold" id="sex-l">Sex</p>
              <Segmented value={v.sex} onChange={(s) => set("sex", s)} label="Sex, used for nutrient targets" className="w-full" options={[{ value: "male", label: "Male" }, { value: "female", label: "Female" }, { value: "other", label: "Other" }]} />
              <p className="mt-1 text-sm text-muted">Used for nutrient targets only.</p>
            </div>
            <Field label="Date of birth" htmlFor="birth" error={fields.birthDate}>
              <Input id="birth" type="date" value={v.birthDate} onChange={(e) => set("birthDate", e.target.value)} autoComplete="bday" aria-invalid={!!fields.birthDate} />
            </Field>
            <Field label="Height (cm)" htmlFor="height" error={fields.heightCm} hint={typeof v.heightCm === "number" && v.heightCm > 0 ? `About ${feetInches(v.heightCm)}` : "For example 183 for 6 ft"}>
              <Input id="height" inputMode="decimal" type="number" step="0.5" value={v.heightCm} onChange={(e) => set("heightCm", num(e.target.value))} aria-invalid={!!fields.heightCm} />
            </Field>
            <Field label="Weight (kg)" htmlFor="weight" error={fields.weightKg}>
              <Input id="weight" inputMode="decimal" type="number" step="0.1" value={v.weightKg} onChange={(e) => set("weightKg", num(e.target.value))} aria-invalid={!!fields.weightKg} />
            </Field>
          </div>
        </SectionCard>

        <SectionCard id="activity" title="Activity" description="How active a normal week is.">
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-labelledby="activity">
            {ACTIVITY.map((a) => (
              <ChoiceCard key={a.value} type="radio" name="activity" checked={v.activityLevel === a.value} onChange={() => set("activityLevel", a.value)} title={a.label} hint={a.hint} />
            ))}
          </div>
        </SectionCard>

        <SectionCard id="targets" title="Daily targets" description="Protein drives the plan. Calories are optional.">
          <div className="space-y-4">
            <div>
              <p className="mb-1 text-sm font-semibold">How to set protein</p>
              <Segmented value={v.proteinMode} label="How to set the protein target" options={[{ value: "per_kg", label: "Grams per kg" }, { value: "fixed", label: "Fixed grams" }]}
                onChange={(m) => setV((p) => ({ ...p, proteinMode: m, proteinValue: m === "per_kg" ? 1.2 : dailyProtein ?? 100 }))} />
            </div>
            {v.proteinMode === "per_kg" ? (
              <div className="flex flex-wrap gap-2" role="group" aria-label="Common targets">
                {PRESETS.map((p) => <Chip key={p.value} on={v.proteinValue === p.value} onClick={() => set("proteinValue", p.value)}>{p.label}</Chip>)}
              </div>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={v.proteinMode === "per_kg" ? "Protein (g per kg of body weight)" : "Protein (g per day)"} htmlFor="protein" error={fields.proteinValue}
                hint={v.proteinMode === "per_kg" ? PRESETS.find((p) => p.value === v.proteinValue)?.hint : undefined}>
                <Input id="protein" inputMode="decimal" type="number" step={v.proteinMode === "per_kg" ? "0.1" : "1"} value={v.proteinValue} onChange={(e) => set("proteinValue", num(e.target.value))} aria-invalid={!!fields.proteinValue} />
              </Field>
              <Field label="Daily calories (optional)" htmlFor="kcal" error={fields.kcalTarget} hint="When set, portions are capped so a day does not run far over.">
                <Input id="kcal" inputMode="numeric" type="number" step="50" value={v.kcalTarget} onChange={(e) => set("kcalTarget", num(e.target.value))} placeholder="Protein only" aria-invalid={!!fields.kcalTarget} />
              </Field>
            </div>
            <p className="text-sm text-muted">Anyone with a kidney condition should set protein with a doctor.</p>
          </div>
        </SectionCard>

        <SectionCard id="reminders" title="Reminders" description="A nudge the evening before something needs soaking or marinating.">
          <Field label="Prep reminder time (optional)" htmlFor="reminder" hint="Reminders are per person. On iPhone they need the app added to the home screen.">
            <Input id="reminder" type="time" value={v.reminderTime} onChange={(e) => set("reminderTime", e.target.value)} className="sm:w-44" />
          </Field>
          {v.id ? <div className="mt-4"><ReminderSettings personId={v.id} personName={v.name || "this person"} publicKey={vapidPublicKey} hasTime={initial.reminderTime !== ""} /></div> : null}
        </SectionCard>

        {v.id ? (
          <SectionCard id="danger" title="Delete profile" description="Removes their preferences and ticks. Plans that include them must be deleted first.">
            {confirmDelete ? (
              <div className="space-y-3">
                <p className="text-sm">Delete {v.name}? This cannot be undone.</p>
                <div className="flex gap-2">
                  <Button variant="danger" onClick={remove} disabled={pending}>Yes, delete</Button>
                  <Button variant="secondary" onClick={() => setConfirmDelete(false)}>Keep</Button>
                </div>
              </div>
            ) : (
              <Button variant="danger" onClick={() => setConfirmDelete(true)}>Delete profile</Button>
            )}
          </SectionCard>
        ) : null}
      </div>

      <aside aria-label="Target summary" className="hidden lg:sticky lg:top-4 lg:block">
        <div className="rounded-card border border-line bg-surface p-5 shadow-sm">
          <div className="flex items-center gap-3">
            <span className="flex size-12 items-center justify-center rounded-full bg-primarysoft font-display text-xl font-bold text-primary" aria-hidden="true">{v.name.trim().charAt(0).toUpperCase() || "?"}</span>
            <div className="min-w-0">
              <p className="truncate text-lg font-semibold">{v.name.trim() || "New profile"}</p>
              <p className="text-sm text-muted">{activityLabel} activity</p>
            </div>
          </div>
          <div className="mt-4 border-t border-line pt-4">
            <p className="text-sm text-muted">Daily protein</p>
            <p className="font-display text-5xl font-bold tabular-nums leading-none">{dailyProtein ?? "--"}<span className="ml-1 text-xl font-medium text-muted">g</span></p>
            {perKg !== null ? <p className="mt-1 text-sm text-muted">{perKg} g per kg of body weight</p> : null}
          </div>
          <dl className="mt-4 space-y-2 border-t border-line pt-4 text-sm">
            <div className="flex justify-between gap-3"><dt className="text-muted">Calories</dt><dd className="font-medium tabular-nums">{v.kcalTarget === "" ? "Not set" : `${v.kcalTarget} kcal`}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Reminder</dt><dd className="font-medium tabular-nums">{v.reminderTime || "Off"}</dd></div>
          </dl>
          <Button type="submit" size="lg" className="mt-5 w-full" loading={pending}>{pending ? "Saving" : saveLabel}</Button>
        </div>
      </aside>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 px-4 pt-3 backdrop-blur lg:hidden" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
        <p className="mb-2 text-sm text-muted">{dailyProtein !== null ? <><strong className="text-fg">{dailyProtein} g</strong> protein a day</> : "Enter a protein target"}</p>
        <Button type="submit" size="lg" className="w-full" loading={pending}>{pending ? "Saving" : saveLabel}</Button>
      </div>
    </form>
  );
}
