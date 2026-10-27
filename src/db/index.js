// Database adapter.
// - Production: real PostgreSQL via `pg` (DATABASE_URL).
// - Local dev / tests: PGlite, an embedded Postgres (WASM) — same SQL dialect, zero setup.
// Both expose the same tiny interface: query(sql, params) -> rows, and tx(fn) for transactions.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
let impl = null;

// Return DATE columns as 'YYYY-MM-DD' strings. The default (a JS Date at local midnight)
// shifts by a day when converted to ISO in IST — a classic off-by-one bug for deadlines.
const DATE_OID = 1082;
const keepDate = (v) => v;
pg.types.setTypeParser(DATE_OID, keepDate);

function pgImpl(connectionString) {
  const local = /localhost|127\.0\.0\.1/.test(connectionString);
  const ssl = process.env.PGSSL === 'false' || local ? false : { rejectUnauthorized: false };
  const pool = new pg.Pool({ connectionString, ssl, max: 10 });
  return {
    kind: 'postgres',
    query: async (text, params) => (await pool.query(text, params)).rows,
    exec: (sql) => pool.query(sql),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(async (text, params) => (await client.query(text, params)).rows);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function pgliteImpl(dataDir) {
  const { PGlite } = await import('@electric-sql/pglite');
  const opts = { parsers: { [DATE_OID]: keepDate } };
  const db = dataDir === 'memory://' ? new PGlite(opts) : new PGlite(dataDir, opts);
  await db.waitReady;
  return {
    kind: 'pglite',
    query: async (text, params) => (await db.query(text, params)).rows,
    exec: (sql) => db.exec(sql),
    tx: (fn) => db.transaction((t) => fn(async (text, params) => (await t.query(text, params)).rows)),
    close: () => db.close(),
  };
}

export async function initDb({ url = process.env.DATABASE_URL, dataDir } = {}) {
  impl = url ? pgImpl(url) : await pgliteImpl(dataDir || process.env.PGLITE_DIR || './.data/pglite');
  const schema = await readFile(path.join(here, 'schema.sql'), 'utf8');
  await impl.exec(schema);
  return impl;
}

function ensure() {
  if (!impl) throw new Error('Database not initialised — call initDb() first');
  return impl;
}

export const query = (text, params) => ensure().query(text, params);
export const tx = (fn) => ensure().tx(fn);
export const closeDb = async () => {
  if (impl) await impl.close();
  impl = null;
};
export const dbKind = () => ensure().kind;

/** Postgres NUMERIC comes back as a string; convert money fields to numbers. */
export const num = (v) => (v === null || v === undefined ? 0 : Number(v));

export const isUniqueViolation = (err) => err && err.code === '23505';
export const isCheckViolation = (err) => err && err.code === '23514';
