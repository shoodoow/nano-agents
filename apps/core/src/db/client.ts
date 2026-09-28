import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema.js";

/**
 * Opens the core database.
 * Input: a Postgres connection URL.
 * Output: a Drizzle client for the account and agent tables.
 */
export function getDb(databaseUrl: string) {
  const sql = postgres(databaseUrl);
  return drizzle(sql, { schema });
}

/**
 * Applies the committed SQL migrations.
 * Input: a Postgres connection URL.
 * Output: nothing. The database matches the migration folder when the promise resolves.
 */
export async function migrateDb(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  const db = drizzle(sql);
  await migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
  await sql.end();
}
