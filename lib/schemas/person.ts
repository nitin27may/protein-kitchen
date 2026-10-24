import { z } from "zod";
import { ACTIVITY_LEVELS, SEXES } from "./index";

export const PersonInput = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().trim().min(1, "Enter a name").max(60),
  sex: z.enum(SEXES),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a birth date"),
  heightCm: z.number({ invalid_type_error: "Enter a height", required_error: "Enter a height" }).min(100, "Height looks too small").max(250, "Height looks too large"),
  weightKg: z.number({ invalid_type_error: "Enter a weight", required_error: "Enter a weight" }).min(30, "Weight looks too small").max(300, "Weight looks too large"),
  activityLevel: z.enum(ACTIVITY_LEVELS),
  proteinMode: z.enum(["per_kg", "fixed"]),
  proteinValue: z.number({ invalid_type_error: "Enter a protein target", required_error: "Enter a protein target" }).positive("Enter a protein target"),
  kcalTarget: z.number().min(1000, "Calories look too low").max(6000, "Calories look too high").nullable(),
  reminderTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM").nullable(),
}).refine((v) => v.proteinMode !== "per_kg" || (v.proteinValue >= 0.6 && v.proteinValue <= 3), {
  message: "Grams per kg should be between 0.6 and 3", path: ["proteinValue"],
}).refine((v) => v.proteinMode !== "fixed" || (v.proteinValue >= 30 && v.proteinValue <= 400), {
  message: "Daily grams should be between 30 and 400", path: ["proteinValue"],
});

export type PersonInputData = z.input<typeof PersonInput>;

export function personRow(v: PersonInputData) {
  return {
    name: v.name, sex: v.sex, birthDate: v.birthDate, heightCm: v.heightCm, weightKg: v.weightKg,
    activityLevel: v.activityLevel,
    proteinTargetG: v.proteinMode === "fixed" ? v.proteinValue : null,
    proteinGPerKg: v.proteinMode === "per_kg" ? v.proteinValue : null,
    kcalTarget: v.kcalTarget, reminderTime: v.reminderTime, dietFlags: [] as string[],
  };
}
