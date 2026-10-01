import { getDb } from "../src/db/client.js";
import { agents, conversations, delegations, messages } from "../src/db/schema.js";
import { desc, eq, sql } from "drizzle-orm";

const db = getDb(process.env.DATABASE_URL!);
const rows = await db.select().from(agents).where(sql`lower(${agents.name}) like '%ashly%'`);
console.log("AGENTS:", JSON.stringify(rows.map((a) => ({ id: a.id, name: a.name, role: a.role, provider: a.provider, modelId: a.modelId })), null, 2));
for (const agent of rows) {
  const convs = await db.select().from(conversations).where(eq(conversations.ownerAgentId, agent.id));
  for (const c of convs) {
    const msgs = await db.select().from(messages).where(eq(messages.conversationId, c.id)).orderBy(messages.createdAt, messages.id);
    console.log("\n===", c.title, c.id, msgs.length, "messages ===");
    for (const m of msgs) {
      const who = m.agentId === agent.id ? agent.name : m.agentId ? "other" : "you";
      console.log(m.createdAt.toISOString(), who + ":", m.body.replace(/\s+/g, " ").slice(0, 280));
    }
    const dels = await db.select().from(delegations).where(eq(delegations.conversationId, c.id)).orderBy(desc(delegations.createdAt)).limit(6);
    for (const d of dels) {
      console.log("WORKER", d.createdAt.toISOString(), d.status, (d.result ?? "").slice(0, 160));
    }
  }
}
await db.$client.end();
