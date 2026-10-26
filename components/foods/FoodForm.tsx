"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { createFood, updateFood } from "@/app/foods/actions";
import { LabelPhotoField } from "@/components/foods/LabelPhotoField";
import { Banner, Button, ChoiceCard, Field, Input, Pill, SectionCard, Segmented, Select } from "@/components/ui";
import { findDuplicates, type CatalogItem } from "@/lib/foods/catalog";
import { screenIngredients } from "@/lib/foods/diet-screen";
import {
  canSaveDraft, draftFromValues, emptyFormValues, evaluateDraft, FOOD_FORM_STATES, needsDensity, OPTIONAL_MICRO_KEYS, type FoodFormValues,
} from "@/lib/foods/form";
import { useHydrated } from "@/lib/hooks/use-hydrated";
import { MICRO_LABELS } from "@/lib/nutrition/labels";

const STATE_LABELS: Record<(typeof FOOD_FORM_STATES)[number], string> = { ready: "Ready to eat", dry: "Dry (weighed before cooking)", cooked: "Cooked", raw: "Raw" };

const FIELD_NAMES: Record<string, string> = {
  name: "Name", barcode: "Barcode", energy: "Energy", protein_g: "Protein", carbs_g: "Carbohydrate", fat_g: "Fat", fibre_g: "Fibre", sugar_g: "Sugars",
  sat_fat_g: "Saturated fat", sodium: "Sodium", servingSize: "Serving size", density: "Weight of the liquid", macros: "Protein, carbohydrate and fat",
  pieceG: "Piece weight",
};
const fieldName = (key: string) => FIELD_NAMES[key] ?? MICRO_LABELS.find((m) => m.key === key)?.label ?? key;

const fmt = (n: number, digits = 1) => n.toLocaleString("en-CA", { maximumFractionDigits: digits });

export interface FoodFormProps {
  /** Present when editing an existing food. */
  uid?: string;
  initial?: FoodFormValues;
  /** The label photo already stored, as a URL the signed-in household can fetch. */
  existingPhotoSrc?: string | null;
  /** Foods the household already has, to warn about a duplicate name or barcode. */
  existing: CatalogItem[];
  /** Log entries that use this food: editing changes their totals. */
  usageCount?: number;
}

/**
 * The label form. Everything is computed by lib/foods/form.ts, which the server runs again before saving: the live
 * preview here is for the person, not a source of truth.
 */
export function FoodForm({ uid, initial, existingPhotoSrc = null, existing, usageCount = 0 }: FoodFormProps) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [v, setV] = useState<FoodFormValues>(initial ?? emptyFormValues());
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [confirmedKey, setConfirmedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [serverFields, setServerFields] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();

  const set = <K extends keyof FoodFormValues>(key: K, value: FoodFormValues[K]) => { setV((p) => ({ ...p, [key]: value })); setServerFields({}); };
  const touch = (key: string) => setTouched((t) => (t[key] ? t : { ...t, [key]: true }));
  const setMicro = (key: string, value: string) => setV((p) => ({ ...p, micros: { ...p.micros, [key]: value } }));

  const { draft, parseErrors } = useMemo(() => draftFromValues(v), [v]);
  const evaluation = useMemo(() => evaluateDraft(draft), [draft]);
  const duplicate = useMemo(() => {
    const others = existing.filter((i) => i.key !== (uid ? `hf:${uid}` : ""));
    return findDuplicates({ name: draft.name, brand: draft.brand ?? null, barcode: draft.barcode ?? null }, others);
  }, [draft.name, draft.brand, draft.barcode, existing, uid]);

  const warnKey = evaluation.validation.warnings.map((w) => w.code).join("|");
  const checked = warnKey !== "" && confirmedKey === warnKey;
  const hardErrors: Record<string, string> = { ...evaluation.fieldErrors, ...parseErrors, ...(duplicate.barcodeMatch ? { barcode: "You already have a food with this barcode." } : {}) };
  const blockedReasons = Object.keys(hardErrors);
  const ready = blockedReasons.length === 0 && canSaveDraft(evaluation, checked);
  const shown = (key: string): string | null => serverFields[key] ?? (touched[key] || (hardErrors[key] && isFilled(v, key)) ? hardErrors[key] ?? null : null);

  const diet = evaluation.diet;
  const dietSuggestion = screenIngredients(v.ingredientsText).suggestions;
  const liquid = needsDensity(draft);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setError(null);
    setServerFields({});
    start(async () => {
      const fd = new FormData();
      fd.set("save", JSON.stringify({ draft, checkedAgainstLabel: checked }));
      if (photo) fd.set("photo", new File([photo], "label.jpg", { type: "image/jpeg" }));
      const r = uid ? await updateFood(uid, fd) : await createFood(fd);
      if (!r.ok) {
        setError(r.error);
        setServerFields(r.fields ?? {});
        return;
      }
      const changed = (r as { affectedEntries?: number }).affectedEntries ?? 0;
      router.push(`/foods/${r.uid}${changed > 0 ? `?saved=${changed}` : "?saved=0"}`);
      router.refresh();
    });
  }

  // The density fields share one message, shown once under the choices.
  const shownFor = (key: keyof FoodFormValues) => (fieldKeyFor(key) === "density" ? null : shown(fieldKeyFor(key)));
  const num = (id: string, label: string, key: keyof FoodFormValues, opts: { hint?: string; required?: boolean } = {}) => (
    <Field label={label} htmlFor={id} hint={opts.hint ?? (opts.required ? undefined : "Leave blank if the label does not show it.")} error={shownFor(key)}>
      <Input id={id} inputMode="decimal" autoComplete="off" value={v[key] as string} onChange={(e) => set(key, e.target.value as never)} onBlur={() => touch(fieldKeyFor(key))}
        aria-invalid={shownFor(key) ? true : undefined} />
    </Field>
  );

  return (
    <div className="px-4 pb-32 lg:grid lg:grid-cols-[minmax(15rem,22rem)_1fr] lg:gap-8 lg:px-0 lg:pb-10">
      <aside className="sticky top-14 z-10 -mx-4 border-b border-line bg-surface/95 px-4 py-2 backdrop-blur lg:top-4 lg:mx-0 lg:self-start lg:rounded-card lg:border lg:p-4">
        <LabelPhotoField existingSrc={existingPhotoSrc} file={photo} onChange={setPhoto} disabled={pending} />
      </aside>

      <form onSubmit={submit} className="mt-4 space-y-4 lg:mt-0" noValidate>
        {usageCount > 0 ? (
          <Banner tone="warn" title={`This changes ${usageCount} past ${usageCount === 1 ? "entry" : "entries"}`}>
            Saving new numbers changes the totals of every day this food was logged.
          </Banner>
        ) : null}

        <SectionCard id="food-basics" title="The food">
          <div className="space-y-3">
            <Field label="Name" htmlFor="food-name" error={shown("name")}>
              <Input id="food-name" value={v.name} maxLength={120} autoComplete="off" onChange={(e) => set("name", e.target.value)} onBlur={() => touch("name")} aria-invalid={shown("name") ? true : undefined} />
            </Field>
            <Field label="Brand" htmlFor="food-brand" hint="Optional.">
              <Input id="food-brand" value={v.brand} maxLength={80} autoComplete="off" onChange={(e) => set("brand", e.target.value)} />
            </Field>
            <Field label="Barcode" htmlFor="food-barcode" hint="Optional. Digits only." error={shown("barcode")}>
              <Input id="food-barcode" inputMode="numeric" autoComplete="off" maxLength={14} value={v.barcode} onChange={(e) => set("barcode", e.target.value.replace(/\D/g, ""))}
                onBlur={() => touch("barcode")} aria-invalid={shown("barcode") ? true : undefined} />
            </Field>
            {duplicate.warning && !duplicate.barcodeMatch ? <Banner tone="warn">{duplicate.warning}</Banner> : null}
            <Field label="How it is weighed" htmlFor="food-state" hint="Dry for flour or lentils weighed before cooking, ready for packaged food eaten as is.">
              <Select id="food-state" value={v.state} onChange={(e) => set("state", e.target.value as FoodFormValues["state"])}>
                {FOOD_FORM_STATES.map((s) => <option key={s} value={s}>{STATE_LABELS[s]}</option>)}
              </Select>
            </Field>
          </div>
        </SectionCard>

        <SectionCard id="food-label" title="What the label says" description="Type the numbers as printed. They are converted to per 100 g for you.">
          <div className="space-y-3">
            <Segmented label="The label is" value={v.basis} onChange={(b) => set("basis", b)}
              options={[{ value: "per_serving", label: "Per serving" }, { value: "per_100g", label: "Per 100 g" }, { value: "per_100ml", label: "Per 100 ml" }]} />
            <div className="grid grid-cols-[1fr_6rem] gap-2">
              <Field label="Serving size" htmlFor="food-serving-size" hint={v.basis === "per_serving" ? "Required for per-serving labels." : "Optional. Lets you log by serving."} error={shown("servingSize")}>
                <Input id="food-serving-size" inputMode="decimal" autoComplete="off" value={v.servingSize} onChange={(e) => set("servingSize", e.target.value)} onBlur={() => touch("servingSize")}
                  aria-invalid={shown("servingSize") ? true : undefined} />
              </Field>
              <Field label="Unit" htmlFor="food-serving-unit">
                <Select id="food-serving-unit" value={v.servingUnit} onChange={(e) => set("servingUnit", e.target.value as "g" | "ml")}>
                  <option value="g">g</option><option value="ml">ml</option>
                </Select>
              </Field>
            </div>
            <Field label="Serving description" htmlFor="food-serving-label" hint="As printed, such as 1/3 cup or 2 pancakes. Optional.">
              <Input id="food-serving-label" value={v.servingLabel} maxLength={60} autoComplete="off" onChange={(e) => set("servingLabel", e.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="One piece is" htmlFor="food-piece-label" hint="Optional, such as biscuit.">
                <Input id="food-piece-label" value={v.pieceLabel} maxLength={60} autoComplete="off" onChange={(e) => set("pieceLabel", e.target.value)} />
              </Field>
              {num("food-piece-g", "Piece weight (g)", "pieceG", { hint: "Optional." })}
            </div>
          </div>
        </SectionCard>

        {liquid ? (
          <SectionCard id="food-density" title="Weight of the liquid" description="Millilitres need a weight to become grams.">
            <div className="space-y-2">
              <ChoiceCard type="radio" name="density" checked={v.densityKind === "pack"} onChange={() => set("densityKind", "pack")} title="Use the pack weight and volume" hint="Net weight and volume printed on the pack." />
              {v.densityKind === "pack" ? (
                <div className="grid grid-cols-2 gap-2 pl-2">
                  {num("food-pack-net", "Net weight (g)", "packNetG", { required: true })}
                  {num("food-pack-volume", "Volume (ml)", "packVolumeMl", { required: true })}
                </div>
              ) : null}
              <ChoiceCard type="radio" name="density" checked={v.densityKind === "serving"} onChange={() => set("densityKind", "serving")} title="Use a serving you weighed" hint="Weigh one serving on a kitchen scale." />
              {v.densityKind === "serving" ? (
                <div className="grid grid-cols-2 gap-2 pl-2">
                  {num("food-serving-weigh", "That serving weighs (g)", "servingWeighG", { required: true })}
                  {v.servingUnit === "ml" ? null : num("food-serving-volume", "That serving is (ml)", "servingVolumeMl", { required: true })}
                </div>
              ) : null}
              <ChoiceCard type="radio" name="density" checked={v.densityKind === "assumed"} onChange={() => set("densityKind", "assumed")} title="Treat 1 ml as 1 g (estimate)" hint="Fine for water-like drinks. The food is marked as an estimated weight." />
              {shown("density") ? <p className="text-sm text-bad" role="alert">{shown("density")}</p> : null}
            </div>
          </SectionCard>
        ) : null}

        <SectionCard id="food-nutrition" title="Nutrition" description={`Values ${v.basis === "per_serving" ? "per serving" : v.basis === "per_100g" ? "per 100 g" : "per 100 ml"}.`}>
          <div className="space-y-3">
            <div className="grid grid-cols-[1fr_auto] items-end gap-2">
              {num("food-energy", "Energy", "energy", { required: true, hint: "Calories are kcal. kJ is converted." })}
              <Segmented label="Energy unit" value={v.energyUnit} onChange={(u) => set("energyUnit", u)} options={[{ value: "kcal", label: "kcal" }, { value: "kJ", label: "kJ" }]} className="mb-6" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              {num("food-protein", "Protein (g)", "protein", { required: true, hint: "Enter 0 if the label shows 0." })}
              {num("food-carbs", "Carbohydrate (g)", "carbs", { required: true, hint: "Enter 0 if the label shows 0." })}
              {num("food-fat", "Fat (g)", "fat", { required: true, hint: "Enter 0 if the label shows 0." })}
              {num("food-fibre", "Fibre (g)", "fibre")}
              {num("food-sugars", "Sugars (g)", "sugars")}
              {num("food-satfat", "Saturated fat (g)", "satFat")}
            </div>
            <div className="grid grid-cols-[1fr_6rem] gap-2">
              {num("food-sodium", "Sodium", "sodium")}
              <Field label="Sodium unit" htmlFor="food-sodium-unit">
                <Select id="food-sodium-unit" value={v.sodiumUnit} onChange={(e) => set("sodiumUnit", e.target.value as "mg" | "g")}>
                  <option value="mg">mg</option><option value="g">g</option>
                </Select>
              </Field>
            </div>
            <details className="rounded-control border border-line p-3">
              <summary className="min-h-11 cursor-pointer text-sm font-semibold leading-[2.75rem]">More nutrients</summary>
              <p className="text-sm text-muted">Anything you leave blank is stored as not reported.</p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {OPTIONAL_MICRO_KEYS.map((key) => {
                  const m = MICRO_LABELS.find((x) => x.key === key)!;
                  return (
                    <Field key={key} label={`${m.label} (${m.unit})`} htmlFor={`food-micro-${key}`} error={shown(key)}>
                      <Input id={`food-micro-${key}`} inputMode="decimal" autoComplete="off" value={v.micros[key] ?? ""} onChange={(e) => setMicro(key, e.target.value)} onBlur={() => touch(key)} />
                    </Field>
                  );
                })}
              </div>
            </details>
          </div>
        </SectionCard>

        <SectionCard id="food-preview" title="Per 100 g" description="What is stored and used for your totals.">
          {evaluation.per100g ? (
            <div aria-live="polite">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3" data-testid="per100g-preview">
                <Stat label="Energy" value={`${fmt(evaluation.per100g.kcal, 0)} kcal`} />
                <Stat label="Protein" value={`${fmt(evaluation.per100g.protein_g)} g`} />
                <Stat label="Carbohydrate" value={`${fmt(evaluation.per100g.carbs_g)} g`} />
                <Stat label="Fat" value={`${fmt(evaluation.per100g.fat_g)} g`} />
                <Stat label="Fibre" value={evaluation.per100g.fibre_g === null ? "not reported" : `${fmt(evaluation.per100g.fibre_g)} g`} />
                {evaluation.servingG !== undefined ? <Stat label="One serving" value={`${fmt(evaluation.servingG)} g`} /> : null}
              </dl>
              {evaluation.estimated ? <p className="mt-2"><Pill tone="warn">Estimated weight</Pill> <span className="text-sm text-muted">These figures assume 1 ml weighs 1 g.</span></p> : null}
            </div>
          ) : (
            <p className="text-sm text-muted">Fill in the label to see the conversion.</p>
          )}
        </SectionCard>

        {evaluation.validation.errors.length || evaluation.validation.warnings.length ? (
          <div className="space-y-2" aria-live="polite">
            {evaluation.validation.errors.map((i) => <Banner key={`${i.field}-${i.code}`} tone="bad"><strong>{fieldName(i.field)}.</strong> {i.message}</Banner>)}
            {evaluation.validation.warnings.map((i) => <Banner key={`${i.field}-${i.code}`} tone="warn"><strong>{fieldName(i.field)}.</strong> {i.message}</Banner>)}
            {evaluation.validation.warnings.length && !evaluation.validation.errors.length ? (
              <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-control border border-strong bg-surface p-3">
                <input type="checkbox" checked={checked} onChange={(e) => setConfirmedKey(e.target.checked ? warnKey : null)} className="mt-0.5 size-5 shrink-0 accent-[var(--primary)]" />
                <span className="text-base font-semibold">I checked these values against the label</span>
              </label>
            ) : null}
          </div>
        ) : null}

        <SectionCard id="food-diet" title="Ingredients and our diet" description="Eggs, gelatin, animal rennet, meat and fish are flagged. Flags never stop you from saving.">
          <div className="space-y-3">
            <Field label="Ingredients" htmlFor="food-ingredients" hint="Optional. Paste the ingredients list from the pack.">
              <textarea id="food-ingredients" rows={4} maxLength={4000} value={v.ingredientsText}
                onChange={(e) => {
                  const text = e.target.value;
                  const s = screenIngredients(text).suggestions;
                  setV((p) => ({ ...p, ingredientsText: text, isDairy: p.isDairy || s.is_dairy, containsOnionGarlic: p.containsOnionGarlic || s.contains_onion_garlic }));
                }}
                className="w-full rounded-control border border-strong bg-surface p-3 text-base placeholder:text-muted" />
            </Field>
            {diet.flags.map((f) => (
              <Banner key={`${f.kind}-${f.label}`} tone="warn" title={f.message}>Found: {f.matches.join(", ")}.</Banner>
            ))}
            {diet.notes.map((n) => <p key={n} className="text-sm text-muted">{n}</p>)}
            <ChoiceCard type="checkbox" checked={v.isDairy} onChange={(c) => set("isDairy", c)} title="Contains dairy" hint={dietSuggestion.is_dairy ? "The ingredients mention dairy." : undefined} />
            <ChoiceCard type="checkbox" checked={v.containsOnionGarlic} onChange={(c) => set("containsOnionGarlic", c)} title="Contains onion or garlic" hint={dietSuggestion.contains_onion_garlic ? "The ingredients mention onion or garlic." : undefined} />
            <ChoiceCard type="checkbox" checked={v.dietChecked} onChange={(c) => set("dietChecked", c)} title="Checked for our diet" hint="Tick when you have read the ingredients and are happy with them." />
          </div>
        </SectionCard>

        {error ? <Banner tone="bad" title="Not saved">{error}</Banner> : null}

        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 px-4 pt-3 backdrop-blur lg:static lg:border-0 lg:bg-transparent lg:px-0 lg:pt-0" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
          {!ready ? (
            <p id="food-save-note" className="mb-2 text-sm text-muted">
              {blockedReasons.length ? `To save: ${blockedReasons.slice(0, 4).map(fieldName).join(", ")}.` : "To save: tick that you checked the values against the label."}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <Button type="submit" size="lg" loading={pending} disabled={!hydrated || !ready} aria-describedby={ready ? undefined : "food-save-note"} className="flex-1 lg:flex-none">
              {uid ? "Save changes" : "Save food"}
            </Button>
            <Button variant="secondary" size="lg" onClick={() => router.push(uid ? `/foods/${uid}` : "/foods")} disabled={pending}>Cancel</Button>
          </div>
        </div>
      </form>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-muted">{label}</dt><dd className="font-semibold tabular-nums">{value}</dd></div>;
}

/** Form value key to the field key the label rules and the server use. */
function fieldKeyFor(key: keyof FoodFormValues): string {
  const map: Partial<Record<keyof FoodFormValues, string>> = {
    protein: "protein_g", carbs: "carbs_g", fat: "fat_g", fibre: "fibre_g", sugars: "sugar_g", satFat: "sat_fat_g", packNetG: "density", packVolumeMl: "density",
    servingWeighG: "density", servingVolumeMl: "density",
  };
  return map[key] ?? key;
}

function isFilled(v: FoodFormValues, key: string): boolean {
  const map: Record<string, keyof FoodFormValues> = { protein_g: "protein", carbs_g: "carbs", fat_g: "fat", fibre_g: "fibre", sugar_g: "sugars", sat_fat_g: "satFat" };
  const value = v[map[key] ?? (key as keyof FoodFormValues)];
  return typeof value === "string" ? value.trim() !== "" : false;
}
