/**
 * Search and filter for the household's food list. Pure: the foods arrive as plain objects.
 * Must not import lib/server, lib/db, lib/auth, lib/human, lib/blob or next/*.
 */
import { buildCatalog, householdKey, searchCatalog, type CatalogItem, type UsageMap } from "./catalog";

export interface SearchableFood {
  uid: string;
  name: string;
  brand: string | null;
  barcode: string | null;
  archived: boolean;
}

/** Catalog entries for household foods, for `searchCatalog` and the duplicate check. */
export function foodCatalog(foods: readonly Pick<SearchableFood, "uid" | "name" | "brand" | "barcode">[]): CatalogItem[] {
  return buildCatalog([], foods.map((f) => ({ uid: f.uid, name: f.name, brand: f.brand, barcode: f.barcode })));
}

/**
 * The foods that match a search by name, brand or exact barcode. Archived foods are left out unless `includeArchived`.
 * With no query every food is listed, the most used first and then by name.
 */
export function filterFoods<T extends SearchableFood>(foods: readonly T[], query: string, options: { includeArchived: boolean; usage?: UsageMap }): T[] {
  const visible = options.includeArchived ? foods : foods.filter((f) => !f.archived);
  const byKey = new Map(visible.map((f) => [householdKey(f.uid), f]));
  const hits = searchCatalog(foodCatalog(visible), query, { limit: visible.length, ...(options.usage ? { usage: options.usage } : {}) });
  return hits.map((h) => byKey.get(h.key)!);
}
