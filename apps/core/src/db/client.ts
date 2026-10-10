import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { config } from "../config.js";
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

let shared: ReturnType<typeof getDb> | undefined;

/**
 * The one database client this process shares.
 * Why: each getDb call opens its own connection pool. Code that has no client
 * handed to it used to open a new pool every time, and none were ever closed.
 * Input: none. Output: the client for the configured database.
 */
export function sharedDb(): ReturnType<typeof getDb> {
  shared ??= getDb(config.databaseUrl());
  return shared;
}

/**
 * Short-transaction query surface shared by db and tx.
 * Why: Phase 11 removed the whole-turn transaction, so every helper that used
 * to take a tx now takes a Store — implemented by either the root db (each
 * call its own short transaction) or an explicit tx (batched callers).
 * Input: none (type only). Output: select/insert/update/delete methods.
 */
export type Store = Pick<ReturnType<typeof getDb>, "select" | "insert" | "update" | "delete">;

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
