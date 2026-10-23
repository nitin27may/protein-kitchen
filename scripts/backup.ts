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
