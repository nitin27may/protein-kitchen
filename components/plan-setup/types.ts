import type { PickerIngredient, PrefSet } from "@/components/IngredientPicker";
import type { StepProblem, WizardDraft } from "@/lib/plan/wizard";
import type { PersonRoutineView, RoutineOption } from "@/lib/routines/types";

export interface SetupPerson {
  id: number;
  name: string;
  proteinTarget: number;
  kcalTarget: number | null;
}

export interface PinRecipe {
  slug: string;
  name: string;
  proteinG: number;
  activeMin: number;
  slots: string[];
}

export interface SetupProps {
  people: SetupPerson[];
  ingredients: PickerIngredient[];
  anchors: { slug: string; label: string }[];
  recipes: PinRecipe[];
  /** True when an earlier plan exists: the flow then opens on the review with last week's choices. */
  hasLastPlan: boolean;
  /** The `?step=` in the address when the page was loaded, if any. */
  initialStep: string | null;
  routines: { catalog: RoutineOption[]; chosen: Record<number, PersonRoutineView[]>; editablePersonIds: number[] };
  initial: {
    personIds: number[];
    length: "7" | "14" | "custom";
    start: string;
    end: string;
    meals: string[];
    cuisineBalance: number;
    timeLimit: "weeknights" | "always20" | "none";
    health: { nutrientDense: boolean; lowSugar: boolean; light: boolean };
    prepStyle: "variety" | "leftovers" | "batch";
    prefs: Record<number, PrefSet>;
  };
}

export type SetDraft = (patch: Partial<WizardDraft>) => void;

export interface StepProps {
  draft: WizardDraft;
  setDraft: SetDraft;
  people: SetupPerson[];
  /** Problems shown beside the controls; empty until the person has tried to move on. */
  problems: StepProblem[];
}
