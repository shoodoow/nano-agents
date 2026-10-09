/**
 * Sends real messages to one agent in a fresh room and prints what the person would see.
 * Why: prompt and loop changes are only proven by a real model run.
 * Usage: npx tsx --env-file .env scripts/live-check.mts <agentId> "<message>" ["<message>" ...]
 * The room is kept; pass its id to scripts/trace-report.mts to see steps and tokens.
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db/client.js";
import { agents, conversations, delegations, members, messages, runs } from "../src/db/schema.js";
import { runTurn } from "../src/turn/orchestrator.js";
import { resolveSkillsDir } from "../src/skills/paths.js";

const [agentId, ...texts] = process.argv.slice(2);
if (!agentId || texts.length === 0) throw new Error("Usage: live-check.mts <agentId> <message...>");
const db = getDb(process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/nano_agents");
const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
if (!agent) throw new Error("Agent not found.");
const skillsRoot = process.env.SKILLS_DIR ?? resolveSkillsDir();
const [room] = await db
  .insert(conversations)
  .values({ accountId: agent.accountId, kind: "direct", ownerAgentId: agent.id, title: `live-check ${agent.label}` })
  .returning();
await db.insert(members).values({ accountId: agent.accountId, conversationId: room!.id, agentId: agent.id });
console.log(`room ${room!.id}`);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const seen = new Set<string>();
async function printNew(): Promise<void> {
  const rows = await db.select().from(messages).where(eq(messages.conversationId, room!.id)).orderBy(messages.createdAt);
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const kinds = Array.isArray(row.payload) ? (row.payload as { kind: string }[]).map((block) => block.kind).join(",") : "";
    console.log(`\n[${new Date().toISOString().slice(11, 19)}] ${row.agentId ? agent!.label : "PERSON"} (${kinds}): ${row.body.slice(0, 1500)}`);
  }
}
/** Waits until no turn and no worker is running in the room, up to a limit. */
async function settle(limitMs: number): Promise<void> {
  const started = Date.now();
  let quiet = 0;
  while (Date.now() - started < limitMs) {
    await sleep(3000);
    await printNew();
    const busyRuns = await db.select({ id: runs.id }).from(runs).where(and(eq(runs.conversationId, room!.id), eq(runs.status, "running")));
    const busyWorkers = await db
      .select({ id: delegations.id })
      .from(delegations)
      .where(and(eq(delegations.conversationId, room!.id), inArray(delegations.status, ["running"])));
    quiet = busyRuns.length + busyWorkers.length === 0 ? quiet + 1 : 0;
    if (quiet >= 4) return;
  }
  console.log("\n(timed out waiting for the room to go quiet)");
}
const limit = Number(process.env.LIVE_LIMIT_MS ?? 600_000);
for (const text of texts) {
  await runTurn(db, agent.accountId, room!.id, text, undefined, skillsRoot);
  await settle(limit);
}
await printNew();
await db.$client.end();
process.exit(0);
