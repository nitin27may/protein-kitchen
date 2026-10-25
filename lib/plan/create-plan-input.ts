import { z } from "zod";
import { MEAL_SLOTS } from "../schemas";

/** Shared by the create-plan action, the anonymous draft and the draft import. Pure: safe in the browser. */
export const CreatePlanInput = z.object({
  personIds: z.array(z.number().int().positive()).min(1, "Choose at least one person"),
  startDate: z.string(),
  endDate: z.string(),
  mealTypes: z.array(z.enum(MEAL_SLOTS)).min(1, "Choose at least one meal type"),
  cuisineBalance: z.number().min(0).max(1),
  maxActiveMin: z.number().int().positive().nullable(),
  pinned: z.array(z.string()),
  healthFocus: z.object({ nutrientDense: z.boolean(), lowSugar: z.boolean(), light: z.boolean() }).default({ nutrientDense: true, lowSugar: true, light: true }),
  prepStyle: z.enum(["variety", "leftovers", "batch"]).default("leftovers"),
  prefs: z.record(z.string(), z.object({ liked: z.array(z.string()), avoided: z.array(z.string()) })),
  /** ISO weekdays (1 = Monday ... 7 = Sunday): when to finish shopping and when to batch cook. Optional. */
  shoppingDay: z.number().int().min(1, "Choose a day from Monday to Sunday").max(7, "Choose a day from Monday to Sunday").nullable().optional(),
  prepDay: z.number().int().min(1, "Choose a day from Monday to Sunday").max(7, "Choose a day from Monday to Sunday").nullable().optional(),
});

export type CreatePlanInputData = z.output<typeof CreatePlanInput>;
