import { feedbackClass } from "./feedback";
import { linksClass } from "./links";
import { registerExporter } from "./registry";
import { personRoutinesClass } from "./routines";
import { savedViewsClass } from "./saved-views";

/**
 * Human-owned data classes known today. Later PRs add one line each: recipe links, photos and photo decisions,
 * routine choices. Idempotent, so any module may import this for its side effect.
 */
let done = false;
export function registerBuiltinClasses(): void {
  if (done) return;
  registerExporter(feedbackClass);
  registerExporter(savedViewsClass);
  registerExporter(linksClass);
  registerExporter(personRoutinesClass);
  done = true;
}
