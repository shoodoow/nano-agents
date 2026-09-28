import { migrateDb } from "./client.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/nano_agents";

await migrateDb(databaseUrl);
