import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config } from "../config.js";

export const db = new pg.Pool({ connectionString: config.DATABASE_URL, max: config.DB_POOL_MAX });

const here = path.dirname(fileURLToPath(import.meta.url));

export async function migrate(): Promise<void> {
  // schema.sql sits next to this file in src/ and is copied to dist/ by the build.
  const sql = readFileSync(path.join(here, "schema.sql"), "utf8");
  await db.query(sql);
}

const STARTUP_LOCK = 7_406_311; // any fixed number; shared by every instance of the app

/**
 * Runs `fn` while holding a Postgres advisory lock, so instances starting together (the api and worker services,
 * or several api instances) take turns. Without it, concurrent `CREATE TABLE IF NOT EXISTS` on a new database
 * fails with a duplicate pg_type key, and the demo seed could run twice.
 */
export async function withStartupLock<T>(fn: () => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [STARTUP_LOCK]);
    try { return await fn(); } finally { await client.query("SELECT pg_advisory_unlock($1)", [STARTUP_LOCK]); }
  } finally {
    client.release();
  }
}
