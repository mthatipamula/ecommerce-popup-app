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
