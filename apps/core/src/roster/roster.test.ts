import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../db/client.js";
import { agents } from "../db/schema.js";
import { createAccount, createAgent, getAgent, updateAgentFlags } from "./roster.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/nano_agents";
const db = getDb(databaseUrl);

describe("roster", () => {
  beforeAll(async () => {
    await db.execute(sql`select 1`);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it("stores an agent with a null linux profile and keeps flags and accounts apart", async () => {
    const first = await createAccount(db, { name: "North" });
    const second = await createAccount(db, { name: "South" });
    const created = await createAgent(db, first.id, {
      name: "Ada",
      label: "Books",
      description: "Keep the ledger.",
      provider: "openai",
      modelId: "gpt-5",
    });
    const other = await createAgent(db, first.id, {
      name: "Bea",
      label: "Mail",
      description: "Read the inbox.",
      provider: "openai",
      modelId: "gpt-5",
    });

    const read = await getAgent(db, first.id, created.id);
    expect(read).toMatchObject({
      name: "Ada",
      label: "Books",
      description: "Keep the ledger.",
      provider: "openai",
      modelId: "gpt-5",
      linuxProfile: null,
    });
    expect(other.linuxProfile).toBeNull();

    const flagged = await updateAgentFlags(db, first.id, created.id, {
      notify: false,
      pinned: true,
      hidden: true,
    });
    expect(flagged).toMatchObject({ notify: false, pinned: true, hidden: true });

    expect(await getAgent(db, second.id, created.id)).toBeNull();

    await db.update(agents).set({ linuxProfile: "ada" }).where(eq(agents.id, created.id));
    await expect(
      db.update(agents).set({ linuxProfile: "ada" }).where(eq(agents.id, other.id)),
    ).rejects.toThrow();
  });
});
