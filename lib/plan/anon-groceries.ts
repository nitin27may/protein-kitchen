import type { AnonDraft } from "./anon-draft";
import { anonGroceries } from "./anon-generate";
import type { AnonLibrary } from "./anon-library";

/** One line of the device grocery list, in the shape the grocery screen draws. Nothing is ticked and no photo is known. */
export interface DeviceGroceryLine {
  slug: string;
  name: string;
  state: string;
  aisle: string;
  image: null;
  needG: number;
  buyG: number;
  packs: number | null;
  pantry: boolean;
  recipes: string[];
  checked: boolean;
}

export function deviceGroceryLines(draft: AnonDraft, library: AnonLibrary): { lines: DeviceGroceryLine[]; singleUse: number } {
  const names = new Map(library.candidates.map((c) => [c.slug, c.name]));
  const list = anonGroceries(draft, library);
  return {
    singleUse: list.singleUseItems,
    lines: list.lines.map((l) => ({
      slug: l.ingredient, name: l.name, state: l.state, aisle: l.aisle, image: null, needG: l.grams, buyG: l.buyGrams,
      packs: l.packs, pantry: l.isPantryStaple, recipes: l.recipes.map((r) => names.get(r) ?? r), checked: false,
    })),
  };
}
