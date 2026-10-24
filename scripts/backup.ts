import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = process.env.DB_PATH ?? path.join(root, "db", "app.db");
if (!fs.existsSync(file)) {
  console.error(`No database at ${file}. Run pnpm seed first.`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(root, "backups");
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `app-${stamp}.db`);

const db = new Database(file, { readonly: true });
db.prepare("VACUUM INTO ?").run(out);
db.close();
console.log(`Backup written to ${out}`);

// Photos live in uploads/ (or UPLOADS_DIR), outside the database. Copied after the database: a photo added in between
// is only extra, while a row pointing at a missing file would be a hole.
const uploads = process.env.UPLOADS_DIR ?? path.join(root, "uploads");
if (fs.existsSync(uploads)) {
  const dest = out.replace(/\.db$/, "-uploads");
  fs.cpSync(uploads, dest, { recursive: true });
  console.log(`Photos copied to ${dest}`);
}
