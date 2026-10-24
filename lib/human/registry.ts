import type { Db } from "../db/client";

export interface BlobRef {
  key: string;
  /** Hex sha256 of the bytes when the row records one; a copy checks it. */
  sha256?: string;
}

export interface ImportContext {
  /** Resolves a recipe slug to its id, following data/renames.json when the slug was renamed. */
  resolveRecipeId(slug: string): Promise<number | undefined>;
}

/**
 * One human-owned data class (feedback, links, photos, saved views, routine choices). A later PR adds its table by
 * calling `registerExporter` once; export, import and slug renames then cover it with no other change.
 */
export interface HumanDataClass {
  /** Stable name used in the manifest and in `sync_state`, for example "recipe-feedback". */
  name: string;
  /** Folder in the export, for example "feedback/". Every file this class writes starts with it. */
  prefix: string;
  /** File path (relative, using `prefix`) to file content. Keyed by slug and uid, never by database id. */
  exportFiles(db: Db): Promise<Record<string, string>>;
  /** Loads this class's files into the database. Must be idempotent. */
  importFiles(db: Db, files: Record<string, string>, ctx: ImportContext): Promise<{ imported: number; skipped: string[] }>;
  /** Optional: the blobs (photo bytes) this class's rows point at, so a backup or restore can copy them with the files. */
  blobs?(db: Db): Promise<BlobRef[]>;
  /** Optional: moves this class's rows from one recipe row to another (a slug rename). Returns true if it moved anything. */
  moveRecipe?(db: Db, fromRecipeId: number, toRecipeId: number): Promise<boolean>;
  /** Optional: true if this class still holds human data for the recipe. A rename never deletes a recipe that does. */
  hasRecipeData?(db: Db, recipeId: number): Promise<boolean>;
}

const classes = new Map<string, HumanDataClass>();

export function registerExporter(cls: HumanDataClass): void {
  const existing = classes.get(cls.name);
  if (existing && existing !== cls) throw new Error(`human data class "${cls.name}" is already registered`);
  for (const other of classes.values()) {
    if (other.name !== cls.name && (other.prefix.startsWith(cls.prefix) || cls.prefix.startsWith(other.prefix))) {
      throw new Error(`human data class "${cls.name}" prefix "${cls.prefix}" overlaps "${other.name}"`);
    }
  }
  classes.set(cls.name, cls);
}

export const registeredClasses = (): HumanDataClass[] => [...classes.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
