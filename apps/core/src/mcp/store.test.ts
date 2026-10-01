import { afterAll, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { accounts, mcpServers } from "../db/schema.js";
import { deleteMcpServer, listMcpServers, saveMcpServer } from "./store.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/nano_agents";
const db = getDb(databaseUrl);

afterAll(async () => {
  await db.$client.end();
});

test("mcp servers are scoped to the account", async () => {
  const [account] = await db.insert(accounts).values({ name: "MCP Account" }).returning();
  const saved = await saveMcpServer(db, account!.id, {
    slug: "crm",
    url: "http://127.0.0.1:9/not-running",
    secret: "",
  });
  expect(saved.slug).toBe("crm");
  expect(saved.lastError).toBeTruthy();
  expect(saved.tools).toEqual([]);
  expect(await listMcpServers(db, account!.id)).toHaveLength(1);
  await deleteMcpServer(db, account!.id, "crm");
  expect(await listMcpServers(db, account!.id)).toHaveLength(0);
  await db.delete(mcpServers).where(eq(mcpServers.accountId, account!.id));
  await db.delete(accounts).where(eq(accounts.id, account!.id));
});
