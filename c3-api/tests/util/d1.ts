import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { unstable_splitSqlQuery } from 'wrangler';

/*
 * The shared APP_DB migration stream, relative to the c3-api directory tests
 * run from.
 */
const MIGRATIONS_DIR = './migrations';

type SqlValue = string | number | null;
type Row = Record<string, SqlValue>;

/*
 * Applies every migration file in name order, as `wrangler d1 migrations
 * apply` does, splitting each file with Wrangler's own trigger-aware splitter.
 * A file runs as one batch, so a failing statement leaves no partial file.
 */
async function applyMigrations(db: D1Database, directory: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
  for (const file of files) {
    const statements = unstable_splitSqlQuery(readFileSync(join(directory, file), 'utf8'));
    await db.batch(statements.map(statement => db.prepare(statement)));
  }
  return files;
}

/*
 * Prepares an INSERT of one row. Table and column names come from test code,
 * values are always bound.
 */
function insertStatement(db: D1Database, table: string, row: Row): D1PreparedStatement {
  const columns = Object.keys(row);
  const placeholders = columns.map((_, index) => `?${index + 1}`);
  return db
    .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`)
    .bind(...Object.values(row));
}

async function insertRow(db: D1Database, table: string, row: Row): Promise<D1Result> {
  return insertStatement(db, table, row).run();
}

/*
 * Rows written by a statement. D1 reports them in `meta.changes`, which
 * workers-types 3.x does not declare.
 */
function changedRows(result: D1Result): number {
  return (result as unknown as { meta: { changes: number } }).meta.changes;
}

async function foreignKeyViolations(db: D1Database): Promise<unknown[]> {
  const { results } = await db.prepare('PRAGMA foreign_key_check').all();
  return results ?? [];
}

export {
  Row,
  SqlValue,
  applyMigrations,
  changedRows,
  foreignKeyViolations,
  insertRow,
  insertStatement,
};
