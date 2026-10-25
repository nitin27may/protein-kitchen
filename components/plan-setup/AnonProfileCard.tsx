"use client";

import { Field, Input, SectionCard, Segmented } from "@/components/ui";
import { type AnonProfileForm, formToProfile } from "@/lib/plan/anon-profile-form";

/** The visitor's "You" profile. It stays on this device until they create an account. */
export function AnonProfileCard({ form, onChange, showErrors }: { form: AnonProfileForm; onChange: (patch: Partial<AnonProfileForm>) => void; showErrors: boolean }) {
  const result = formToProfile(form);
  const errors = showErrors && !result.ok ? result.errors : {};
  const target = result.ok ? (result.profile.protein.mode === "fixed" ? result.profile.protein.grams : Math.round(result.profile.protein.gPerKg * result.profile.protein.weightKg)) : null;
  return (
    <SectionCard id="you" title="You" description="Your protein target sizes every portion. It stays on this device until you create an account.">
      <div className="space-y-4">
        <Field label="Name (optional)" htmlFor="anon-name">
          <Input id="anon-name" value={form.name} maxLength={60} autoComplete="given-name" onChange={(e) => onChange({ name: e.target.value })} />
        </Field>
        <Segmented<"perKg" | "fixed"> value={form.mode} onChange={(mode) => onChange({ mode })} label="How to set protein" options={[{ value: "perKg", label: "Per kilogram" }, { value: "fixed", label: "Fixed grams" }]} />
        {form.mode === "perKg" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Protein, g per kg" htmlFor="anon-gperkg" error={errors.gPerKg}>
              <Input id="anon-gperkg" inputMode="decimal" value={form.gPerKg} onChange={(e) => onChange({ gPerKg: e.target.value })} />
            </Field>
            <Field label="Weight, kg" htmlFor="anon-weight" error={errors.weightKg}>
              <Input id="anon-weight" inputMode="decimal" value={form.weightKg} onChange={(e) => onChange({ weightKg: e.target.value })} />
            </Field>
          </div>
        ) : (
          <Field label="Protein a day, g" htmlFor="anon-grams" error={errors.grams}>
            <Input id="anon-grams" inputMode="numeric" value={form.grams} onChange={(e) => onChange({ grams: e.target.value })} />
          </Field>
        )}
        <Field label="Calories a day (optional)" htmlFor="anon-kcal" error={errors.kcal}>
          <Input id="anon-kcal" inputMode="numeric" value={form.kcal} onChange={(e) => onChange({ kcal: e.target.value })} />
        </Field>
        <p className="text-sm text-muted" aria-live="polite">{target !== null ? <>Target: <strong className="text-fg">{target} g protein a day</strong>.</> : "Fill in the target to continue."}</p>
      </div>
    </SectionCard>
  );
}
