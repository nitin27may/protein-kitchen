import type { Recipe } from "../schemas";

/**
 * How to store and reheat. A recipe's own `storage` text wins. Otherwise this is built from its fridge days and type.
 * The fridge-day figures follow the batch prep card: cooked beans 4 days, grains 4 to 5, soups 3 to 4, dressings 5 to 7.
 */
export function storageAdvice(r: Pick<Recipe, "storage" | "fridge_days" | "kind" | "family" | "name">): string {
  if (r.storage) return r.storage;
  const days = r.fridge_days;
  if (days <= 1) return "Best eaten the day it is made. If you must keep it, cover it and refrigerate for up to 1 day.";
  if (r.family === "dressings" || r.family === "sauces") {
    return `Keep in a sealed jar in the fridge for up to ${days} days. Shake or stir before using, and take oil-based dressings out 10 minutes early because they thicken when cold.`;
  }
  if (r.family === "soups") {
    return `Cool within 2 hours, then refrigerate in a covered container for up to ${days} days or freeze in portions for up to 3 months. Reheat until steaming hot, adding water because lentils and beans thicken as they sit.`;
  }
  if (r.family === "salads" || r.family === "bowls") {
    return `Store the dressing, greens and wet ingredients separately and combine when you eat. The undressed base keeps ${days} days in an airtight container.`;
  }
  return `Cool within 2 hours, then refrigerate in an airtight container for up to ${days} days. Reheat until steaming hot throughout.`;
}
