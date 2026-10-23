export const round1 = (n: number) => Math.round(n * 10) / 10;

export function grams(n: number): string {
  if (n >= 1000) return `${round1(n / 1000)} kg`;
  return `${Math.round(n)} g`;
}

export function servingsLabel(n: number): string {
  const whole = Math.floor(n);
  const frac = n - whole;
  const f = frac === 0.25 ? "¼" : frac === 0.5 ? "½" : frac === 0.75 ? "¾" : "";
  if (!f) return String(n);
  return whole === 0 ? f : `${whole}${f}`;
}

export function ageFrom(birthDate: string, now: Date = new Date()): number {
  const b = new Date(`${birthDate}T00:00:00Z`);
  let age = now.getUTCFullYear() - b.getUTCFullYear();
  const m = now.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < b.getUTCDate())) age--;
  return age;
}

export const SLOT_LABEL: Record<string, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
  snack: "Snack",
  shake: "Shake",
};

const AISLE_LABEL: Record<string, string> = {
  vegetables: "Vegetables",
  fruit: "Fruit",
  dairy: "Dairy",
  "soy-protein": "Soy and protein",
  legumes: "Legumes and dals",
  grains: "Grains",
  flours: "Flours",
  "nuts-seeds": "Nuts and seeds",
  "dried-fruit": "Dried fruit",
  oils: "Oils",
  fats: "Fats",
  spices: "Spices",
  pantry: "Pantry",
  supplements: "Supplements",
};

export function aisleLabel(aisle: string): string {
  return AISLE_LABEL[aisle] ?? aisle;
}
