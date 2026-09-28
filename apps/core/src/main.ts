import { getDb } from "./db/client.js";
import { startServer } from "./http/server.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/nano_agents";
const port = Number(process.env.PORT ?? 3000);

await startServer(getDb(databaseUrl), port);
