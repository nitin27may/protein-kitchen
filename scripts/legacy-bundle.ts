import fs from "node:fs";
import path from "node:path";
import { readSqliteSnapshot } from "../lib/db/sqlite-snapshot";
import { loadRenames } from "../lib/db/renames";
import { buildLegacyBundle, MAX_BUNDLE_BYTES } from "../lib/legacy/bundle";
import { stableJson } from "../lib/human/util";

/**
 * Local only: reads a COPY of the old SQLite file read-only, writes one JSON file. No network, no database URL, no
 * credentials. The owner uploads the file from Settings after signing up; see docs/launch/wp7-legacy-import.md.
 */
const args = process.argv.slice(2);
const withPlans = args.includes("--with-plans");
const paths = args.filter((a) => !a.startsWith("--"));
const unknown = args.filter((a) => a.startsWith("--") && a !== "--with-plans");
if (unknown.length || paths.length !== 2) {
  throw new Error("Usage: pnpm legacy:bundle [--with-plans] /absolute/path/to/source-copy.db /absolute/path/to/bundle.json");
}
const [source, out] = paths as [string, string];
if (!path.isAbsolute(source) || !path.isAbsolute(out)) throw new Error("Both paths must be absolute.");
if (path.resolve(source) === path.resolve(out)) throw new Error("The output file must differ from the source.");

const bundle = buildLegacyBundle(readSqliteSnapshot(source), { withPlans, renames: loadRenames() });
const text = stableJson(bundle);
if (Buffer.byteLength(text) > MAX_BUNDLE_BYTES) throw new Error("The bundle is larger than the 4 MB upload limit. Build it without --with-plans or trim the source copy.");
// wx: never overwrite an existing file.
fs.writeFileSync(out, text, { flag: "wx", mode: 0o600 });
console.log(`Wrote ${out} (${Buffer.byteLength(text)} bytes, plans ${withPlans ? "included" : "excluded"}).`);
for (const [name, n] of Object.entries(bundle.manifest.counts).sort(([a], [b]) => a.localeCompare(b))) console.log(`${name}: ${n}`);
console.log(`sha256 ${bundle.manifest.sha256}`);
console.log("Excluded: library tables, sync_state, push subscriptions, reminder logs, photos and photo decisions.");
