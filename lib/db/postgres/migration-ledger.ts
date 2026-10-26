export interface ExpectedMigration { hash: string; folderMillis: number }
export interface LedgerRow { hash: string; created_at: string | number | bigint }

/**
 * The applied ledger must be an exact ordered prefix of the reviewed migration list. With `complete`, it must be the
 * whole list. Messages carry no hashes or database content.
 */
export function requireMigrationPrefix(rows: readonly LedgerRow[], expected: readonly ExpectedMigration[], complete = false): void {
  if (rows.length > expected.length || (complete && rows.length !== expected.length) ||
      rows.some((row, i) => row.hash !== expected[i]!.hash || Number(row.created_at) !== expected[i]!.folderMillis)) {
    throw new Error("Migration ledger is pending or divergent.");
  }
}
