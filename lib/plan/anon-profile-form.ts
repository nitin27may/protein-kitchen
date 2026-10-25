import { AnonProfileSchema, type AnonProfile } from "./anon-draft";

/** The "You" profile form for a visitor: text fields in, a validated device profile or field messages out. */
export interface AnonProfileForm {
  name: string;
  mode: "perKg" | "fixed";
  gPerKg: string;
  weightKg: string;
  grams: string;
  kcal: string;
}

export const DEFAULT_ANON_FORM: AnonProfileForm = { name: "", mode: "perKg", gPerKg: "1.2", weightKg: "", grams: "", kcal: "" };

export type AnonFormResult =
  | { ok: true; profile: AnonProfile }
  | { ok: false; errors: Partial<Record<"gPerKg" | "weightKg" | "grams" | "kcal", string>> };

const num = (text: string): number | null => {
  const t = text.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : Number.NaN;
};

export function formToProfile(form: AnonProfileForm, prefs: { liked: string[]; avoided: string[] } = { liked: [], avoided: [] }): AnonFormResult {
  const errors: Partial<Record<"gPerKg" | "weightKg" | "grams" | "kcal", string>> = {};
  const kcal = num(form.kcal);
  if (kcal !== null && (!Number.isInteger(kcal) || kcal < 1000 || kcal > 6000)) errors.kcal = "Enter calories between 1000 and 6000, or leave it blank.";
  let protein: unknown;
  if (form.mode === "perKg") {
    const g = num(form.gPerKg);
    const w = num(form.weightKg);
    if (g === null || Number.isNaN(g) || g < 0.6 || g > 3) errors.gPerKg = "Enter grams per kilogram between 0.6 and 3.";
    if (w === null || Number.isNaN(w) || w < 30 || w > 300) errors.weightKg = "Enter your weight in kilograms (30 to 300).";
    protein = { mode: "perKg", gPerKg: g, weightKg: w };
  } else {
    const g = num(form.grams);
    if (g === null || Number.isNaN(g) || !Number.isInteger(g) || g < 30 || g > 400) errors.grams = "Enter a whole number of grams between 30 and 400.";
    protein = { mode: "fixed", grams: g };
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  const slugOk = (s: string) => /^[a-z0-9][a-z0-9-]{0,99}$/.test(s);
  const avoided = prefs.avoided.filter(slugOk);
  const parsed = AnonProfileSchema.safeParse({
    name: form.name, protein, kcalTarget: kcal, liked: prefs.liked.filter(slugOk).filter((s) => !avoided.includes(s)), avoided,
  });
  if (!parsed.success) return { ok: false, errors: { gPerKg: "Check the protein target." } };
  return { ok: true, profile: parsed.data };
}

export function profileToForm(profile: AnonProfile): AnonProfileForm {
  return {
    name: profile.name === "You" ? "" : profile.name,
    mode: profile.protein.mode,
    gPerKg: profile.protein.mode === "perKg" ? String(profile.protein.gPerKg) : DEFAULT_ANON_FORM.gPerKg,
    weightKg: profile.protein.mode === "perKg" ? String(profile.protein.weightKg) : "",
    grams: profile.protein.mode === "fixed" ? String(profile.protein.grams) : "",
    kcal: profile.kcalTarget === null ? "" : String(profile.kcalTarget),
  };
}
