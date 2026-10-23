/** Health Canada DRI for adults aged 31 to 50 (RDA or AI). Source: docs/nutrient-targets.md. */
export interface Target {
  key: string;
  label: string;
  unit: string;
  male: number;
  female: number;
}

export const TARGETS: Target[] = [
  { key: "fibre_g", label: "Fibre", unit: "g", male: 38, female: 25 },
  { key: "calcium_mg", label: "Calcium", unit: "mg", male: 1000, female: 1000 },
  { key: "iron_mg", label: "Iron", unit: "mg", male: 8, female: 18 },
  { key: "zinc_mg", label: "Zinc", unit: "mg", male: 11, female: 8 },
  { key: "magnesium_mg", label: "Magnesium", unit: "mg", male: 420, female: 320 },
  { key: "potassium_mg", label: "Potassium", unit: "mg", male: 3400, female: 2600 },
  { key: "vitamin_c_mg", label: "Vitamin C", unit: "mg", male: 90, female: 75 },
  { key: "vitamin_b12_ug", label: "Vitamin B12", unit: "µg", male: 2.4, female: 2.4 },
  { key: "vitamin_d_ug", label: "Vitamin D", unit: "µg", male: 15, female: 15 },
];

export function targetFor(key: string, sex: "male" | "female" | "other"): number | undefined {
  const t = TARGETS.find((x) => x.key === key);
  if (!t) return undefined;
  return sex === "female" ? t.female : t.male;
}
