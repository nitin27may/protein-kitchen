/** Share of energy from each macro, using 4 kcal/g for protein and carbs and 9 kcal/g for fat. */
export function energySplit(proteinG: number, carbsG: number, fatG: number): { p: number; c: number; f: number } {
  const total = proteinG * 4 + carbsG * 4 + fatG * 9;
  if (total <= 0) return { p: 0, c: 0, f: 0 };
  return { p: (proteinG * 4 * 100) / total, c: (carbsG * 4 * 100) / total, f: (fatG * 9 * 100) / total };
}
