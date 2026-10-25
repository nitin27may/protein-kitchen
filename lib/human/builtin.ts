import { feedbackClass } from "./feedback";
import { linksClass } from "./links";
import { photoDecisionsClass, photosClass } from "./photos";
import { registerExporter } from "./registry";
import { personRoutinesClass } from "./routines";
import { savedViewsClass } from "./saved-views";
import { personalFeedbackClass } from "./personal-feedback";

/**
 * Human-owned data classes known today. A new class adds one line here. Idempotent, so any module may import this for its side effect.
 */
let done = false;
export function registerBuiltinClasses(): void {
  if (done) return;
  registerExporter(feedbackClass);
  registerExporter(personalFeedbackClass);
  registerExporter(savedViewsClass);
  registerExporter(linksClass);
  registerExporter(personRoutinesClass);
  registerExporter(photosClass);
  registerExporter(photoDecisionsClass);
  done = true;
}
