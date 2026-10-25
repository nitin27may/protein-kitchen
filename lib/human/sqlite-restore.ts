import { getTableName, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { Db } from "../db/client";
import { digestRows, importColumns, importTables } from "../db/sqlite-snapshot";
import type { ImportRow, SqliteSnapshot, TableDigest } from "../db/sqlite-snapshot";
import * as s from "../db/schema";
import { withTx } from "../db/tx";
import { bindImportedHousehold } from "./household-migration";

function dependencyOrder() {
  const remaining = [...importTables];
  const ordered: typeof importTables = [];
  while (remaining.length) {
    const next = remaining.find((table) => getTableConfig(table).foreignKeys.every((fk) => {
      const reference = fk.reference();
      if (!reference.columns.some((column) => importColumns(table).includes(column))) return true;
      const parent = reference.foreignTable;
      return parent === table || ordered.some((done) => getTableName(done) === getTableName(parent));
    }));
    if (!next) throw new Error("SQLite import table dependencies contain a cycle.");
    ordered.push(next);
    remaining.splice(remaining.indexOf(next), 1);
  }
  return ordered;
}

async function readTargetRows(db: Db, table: (typeof importTables)[number]): Promise<ImportRow[]> {
  const columns = Object.fromEntries(importColumns(table).map((column) => [column.name, column]));
  return db.select(columns).from(table);
}

/**
 * Migration-only human-data restore, not a library seed or a normal app mutation. Keeps original ids, uids,
 * legacy timestamps and sync markers exactly as snapshotted; new Postgres-only columns use their defaults.
 * Never invents feedback or stamps it as a new human change.
 * An empty destination is mandatory. Any insert/checksum failure rolls all rows back; no truncate or overwrite.
 */
export async function restoreSqliteSnapshot(db: Db, snapshot: SqliteSnapshot): Promise<Record<string, TableDigest>> {
  const ordered = dependencyOrder();
  const names = ordered.map(getTableName).sort();
  if (JSON.stringify(Object.keys(snapshot.rows).sort()) !== JSON.stringify(names) ||
      JSON.stringify(Object.keys(snapshot.tables).sort()) !== JSON.stringify(names)) {
    throw new Error("SQLite snapshot must include exactly the supported legacy tables.");
  }
  for (const name of names) {
    const digest = digestRows(snapshot.rows[name]!);
    if (digest.count !== snapshot.tables[name]!.count || digest.sha256 !== snapshot.tables[name]!.sha256) {
      throw new Error(`SQLite snapshot checksum mismatch for ${name}.`);
    }
  }
  if (!names.some((name) => snapshot.tables[name]!.count > 0)) {
    throw new Error("SQLite snapshot contains no application rows; initialize a fresh library with the guarded seed instead.");
  }
  return withTx(db, async (tx) => {
    await tx.execute(sql`set local lock_timeout = '10s'`);
    // Block competing imports and app writes before testing emptiness; selects remain possible.
    const allTables = Object.values(s).sort((a, b) => getTableName(a).localeCompare(getTableName(b)));
    await tx.execute(sql`lock table ${sql.join(allTables.map((t) => sql.identifier(getTableName(t))), sql`, `)} in exclusive mode`);
    for (const table of allTables) {
      if ((await tx.select().from(table).limit(1)).length) {
        throw new Error(`SQLite import requires an empty destination; ${getTableName(table)} is not empty.`);
      }
    }
    for (const table of ordered) {
      const name = getTableName(table);
      const columns = importColumns(table);
      for (const row of snapshot.rows[name]!) {
        const values = columns.map((column) => {
          const value = row[column.name];
          return value === null ? sql`null` : sql`${column.mapToDriverValue(value)}`;
        });
        await tx.execute(sql`insert into ${table} (${sql.join(columns.map((c) => sql.identifier(c.name)), sql`, `)}) values (${sql.join(values, sql`, `)})`);
      }
    }
    const verified: Record<string, TableDigest> = {};
    for (const table of ordered) {
      const name = getTableName(table);
      verified[name] = digestRows(await readTargetRows(tx, table));
      if (verified[name]!.count !== snapshot.tables[name]!.count || verified[name]!.sha256 !== snapshot.tables[name]!.sha256) {
        throw new Error(`Postgres verification failed for ${name}; the import was rolled back.`);
      }
    }
    // ALTER SEQUENCE RESTART is transactional, unlike setval(). A failed import never leaves sequences advanced.
    for (const table of ordered) {
      const { name, columns } = getTableConfig(table);
      const identity = columns.find((column) => column.generatedIdentity);
      if (!identity) continue;
      const nextId = snapshot.rows[name]!.reduce((max, row) => Math.max(max, Number(row[identity.name])), 0) + 1;
      if (nextId > 2147483647) throw new Error(`Identity range exhausted for ${name}.`);
      await tx.execute(sql`alter table ${table} alter column ${sql.identifier(identity.name)} restart with ${sql.raw(String(nextId))}`);
    }
    await bindImportedHousehold(tx);
    return verified;
  });
}
