import type { Db } from "../db/client";
import { registerBuiltinClasses } from "./builtin";
import { registeredClasses } from "./registry";
import { sha256 } from "./util";

export interface ExportBundle {
  manifest: { version: 1 | 2; tables: Record<string, { count: number; sha256: string }> };
  /** Relative path to file content. Paths use slugs and uids, never database ids. */
  files: Record<string, string>;
}

/** Checksum of one class: the sorted paths and contents, so a renamed or edited file changes it. */
function checksum(files: Record<string, string>): string {
  return sha256(Object.keys(files).sort().map((p) => `${p}\n${files[p]}`).join("\u0000"));
}

/**
 * Turns every human-owned data class into files. Output is byte-stable: the same data always gives the same
 * files. Rows written before uids and timestamps existed get them filled in once, as a side effect.
 */
export async function exportHumanData(db: Db): Promise<ExportBundle> {
  registerBuiltinClasses();
  const files: Record<string, string> = {};
  const tables: ExportBundle["manifest"]["tables"] = {};
  for (const cls of registeredClasses()) {
    const part = await cls.exportFiles(db);
    for (const [path, content] of Object.entries(part)) {
      if (!path.startsWith(cls.prefix)) throw new Error(`${cls.name} wrote "${path}" outside its folder "${cls.prefix}"`);
      files[path] = content;
    }
    tables[cls.name] = { count: Object.keys(part).length, sha256: checksum(part) };
  }
  // Sorted by path, so the bundle is identical whatever order the database returned rows in.
  const sorted = Object.fromEntries(Object.entries(files).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
  return { manifest: { version: 2, tables }, files: sorted };
}
