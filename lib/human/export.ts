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
 * Turns all or explicitly selected human-owned classes into files. Output is byte-stable: the same data gives the same
 * files. Rows written before uids and timestamps existed get them filled in once, as a side effect.
 */
export async function exportHumanData(db: Db, dataClasses?: readonly string[]): Promise<ExportBundle> {
  registerBuiltinClasses();
  const all = registeredClasses();
  if (dataClasses && (!dataClasses.length || new Set(dataClasses).size !== dataClasses.length)) {
    throw new Error("Select at least one human data class without duplicates.");
  }
  const selected = dataClasses ? dataClasses.map((name) => {
    const cls = all.find((candidate) => candidate.name === name);
    if (!cls) throw new Error(`Unknown human data class "${name}".`);
    return cls;
  }).sort((a, b) => a.name < b.name ? -1 : 1) : all;
  const files: Record<string, string> = {};
  const tables: ExportBundle["manifest"]["tables"] = {};
  for (const cls of selected) {
    const part = await cls.exportFiles(db);
    for (const [path, content] of Object.entries(part)) {
      if (!path.startsWith(cls.prefix)) throw new Error(`${cls.name} wrote "${path}" outside its folder "${cls.prefix}"`);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(path) || path.split("/").some((segment) => !segment || segment === "." || segment === ".." || segment === ".git")) {
        throw new Error(`${cls.name} wrote an unsafe export path.`);
      }
      files[path] = content;
    }
    tables[cls.name] = { count: Object.keys(part).length, sha256: checksum(part) };
  }
  // Sorted by path, so the bundle is identical whatever order the database returned rows in.
  const sorted = Object.fromEntries(Object.entries(files).sort(([x], [y]) => (x < y ? -1 : 1)));
  return { manifest: { version: 2, tables }, files: sorted };
}
