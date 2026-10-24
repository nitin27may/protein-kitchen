import { draftDayCount, draftEnd } from "@/lib/plan/wizard";
import type { WizardDraft } from "@/lib/plan/wizard";
import { DAY_LABEL } from "@/lib/routines/types";
import { fmtRange, listNames, MEALS, STYLE_LABEL, TIME_LIMIT_LABEL, WEEKDAY_NAME } from "./constants";
import type { SetupPerson } from "./types";

/** The same plain-language lines for the live summary on wide screens and the cards on the review step. */
export interface DraftSummary {
  dayCount: number;
  mealCount: number;
  range: string;
  eating: string;
  meals: string;
  style: string;
  timeLimit: string;
  likes: string;
  avoids: string;
  focus: string;
  cuisine: string;
  pinned: string;
  days: string;
}

export function summarise(draft: WizardDraft, people: SetupPerson[], nameOf: (slug: string) => string, recipeName: (slug: string) => string): DraftSummary {
  const selected = people.filter((p) => draft.personIds.includes(p.id));
  const anchor = selected.length ? selected : people.slice(0, 1);
  const names = (key: "liked" | "avoided") => [...new Set(anchor.flatMap((p) => draft.prefs[p.id]?.[key] ?? []))].map(nameOf);
  const dayCount = draftDayCount(draft);
  const end = draftEnd(draft);
  const focus = [draft.health.nutrientDense && "nutrient-dense", draft.health.lowSugar && "low sugar", draft.health.light && "lighter"].filter(Boolean).join(", ");
  const dayBits = [draft.shoppingDay ? `Shop on ${WEEKDAY_NAME[draft.shoppingDay]}` : null, draft.prepDay ? `prep on ${WEEKDAY_NAME[draft.prepDay]}` : null].filter(Boolean) as string[];
  return {
    dayCount,
    mealCount: dayCount > 0 ? dayCount * draft.meals.length : 0,
    range: dayCount > 0 ? fmtRange(draft.start, end) : "Check the dates.",
    eating: selected.length ? selected.map((p) => `${p.name} (${p.proteinTarget} g)`).join(", ") : "No one selected",
    meals: draft.meals.length ? MEALS.filter((m) => draft.meals.includes(m.id)).map((m) => m.label).join(", ") : "None selected",
    style: STYLE_LABEL[draft.prepStyle],
    timeLimit: TIME_LIMIT_LABEL[draft.timeLimit],
    likes: listNames(names("liked")),
    avoids: listNames(names("avoided")),
    focus: focus || "None",
    cuisine: `${Math.round(draft.cuisine * 100)}% Indian`,
    pinned: draft.pinned.length ? listNames(draft.pinned.map(recipeName)) : "None",
    days: dayBits.length ? dayBits.join(", ") : "No shopping or prep day set",
  };
}

export { DAY_LABEL };
