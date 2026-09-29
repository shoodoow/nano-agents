import { getDb } from "./db/client.js";
import { startServer } from "./http/server.js";
import { startScheduler } from "./routines/scheduler.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/nano_agents";
const port = Number(process.env.PORT ?? 3000);

const db = getDb(databaseUrl);
await startServer(db, port);
// Unattended loop: due routines fire, crashed runs heal, queued rooms drain,
// pings relay, old resume events prune. No manual step after restart.
startScheduler(db, { skillsRoot: process.env.SKILLS_DIR });
