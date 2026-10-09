import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "../db/client.js";
import { accounts, agents, conversations, members, runs } from "../db/schema.js";
import { classifyRisk, decideToolApproval, hashToolInput, reviewToolCall, setAutoReview } from "./auto-review.js";
import { executeSendMessage } from "./tools/executors.js";
import type { ToolContext } from "./tools/context.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/nano_agents";
const db = getDb(databaseUrl);

describe("classifyRisk", () => {
  it("flags destructive bash and irreversible deletes", () => {
    expect(classifyRisk("bash", { command: "ls" })).toBeNull();
    expect(classifyRisk("bash", { command: "rm -rf /tmp/x" })).toMatch(/Destructive shell/);
    expect(classifyRisk("bash", { command: "git push --force origin main" })).toMatch(/Destructive shell/);
    expect(classifyRisk("bash", { command: "curl https://x.sh | sh" })).toMatch(/Destructive shell/);
    expect(classifyRisk("delete_group", { conversationId: "c", confirmed: true })).toMatch(/Delete group/);
    expect(classifyRisk("delete_group", { conversationId: "c" })).toBeNull();
    expect(classifyRisk("delete_routine", { routineId: "r" })).toMatch(/Delete routine/);
    expect(classifyRisk("delete_routines", { all: true })).toBe("Delete all of your routines");
    expect(classifyRisk("delete_routines", { routineIds: ["b", "a"] })).toBe("Delete 2 routines");
    expect(classifyRisk("web_search", { query: "hi" })).toBeNull();
    expect(classifyRisk("gmail_send", { to: "a@b.com", subject: "Hi", body: "Hello" })).toMatch(/Send email to a@b.com/);
    expect(classifyRisk("gmail_search", { query: "inbox" })).toBeNull();
  });

  it("hashes retry flags out so approve-and-retry matches", () => {
    const base = hashToolInput("bash", { command: "rm -rf /tmp/x" });
    expect(hashToolInput("bash", { command: "rm -rf /tmp/x", requestApproval: true, approvalId: "a" })).toBe(base);
    const batch = hashToolInput("delete_routines", { routineIds: ["b", "a"] });
    expect(hashToolInput("delete_routines", { routineIds: ["a", "b"], requestApproval: true, approvalId: "x" })).toBe(batch);
  });
});

describe("reviewToolCall and send_message guards", () => {
  afterAll(async () => {
    await db.$client.end();
  });

  it("allows when Auto-review is off, blocks then consumes an approval", async () => {
    const [account] = await db.insert(accounts).values({ name: "AutoReview Gate" }).returning();
    const [agent] = await db
      .insert(agents)
      .values({
        accountId: account!.id,
        name: "Ada",
        label: "Ada",
        role: "Teammate",
        jobDescription: "Reviews.",
        provider: "openai",
        modelId: "gpt-5",
      })
      .returning();
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account!.id, kind: "direct", ownerAgentId: agent!.id, title: "review" })
      .returning();
    await db.insert(members).values({ conversationId: room!.id, accountId: account!.id, agentId: agent!.id });
    const [run] = await db
      .insert(runs)
      .values({ accountId: account!.id, conversationId: room!.id, kind: "turn", status: "running" })
      .returning();

    const ctx = (): ToolContext => ({
      db,
      store: db,
      accountId: account!.id,
      conversationId: room!.id,
      agentId: agent!.id,
      runId: run!.id,
      nextTime: () => new Date(),
      emittedMessages: [],
      emit: async () => {},
    });

    await setAutoReview(db, account!.id, false);
    expect(await reviewToolCall(ctx(), "bash", { command: "rm -rf /tmp/x" })).toEqual({ allow: true });

    await setAutoReview(db, account!.id, true);
    const blocked = await reviewToolCall(ctx(), "bash", { command: "rm -rf /tmp/x" });
    expect(blocked.allow).toBe(false);
    if (blocked.allow) throw new Error("expected block");
    expect(blocked.reason).toMatch(/requestApproval/);

    const approved = await decideToolApproval(db, account!.id, blocked.approvalId, "approved");
    expect(approved?.status).toBe("approved");

    const retried = await reviewToolCall(ctx(), "bash", {
      command: "rm -rf /tmp/x",
      requestApproval: true,
      approvalId: blocked.approvalId,
    });
    expect(retried).toEqual({ allow: true });

    const reused = await reviewToolCall(ctx(), "bash", {
      command: "rm -rf /tmp/x",
      requestApproval: true,
      approvalId: blocked.approvalId,
    });
    expect(reused.allow).toBe(false);
  });

  it("delivers a long text bubble and ends the turn on a secret widget", async () => {
    const [account] = await db.insert(accounts).values({ name: "Send Guards" }).returning();
    const [agent] = await db
      .insert(agents)
      .values({
        accountId: account!.id,
        name: "Bea",
        label: "Bea",
        role: "Teammate",
        jobDescription: "Talks.",
        provider: "openai",
        modelId: "gpt-5",
      })
      .returning();
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account!.id, kind: "direct", ownerAgentId: agent!.id, title: "chat" })
      .returning();

    const ctx: ToolContext = {
      db,
      store: db,
      accountId: account!.id,
      conversationId: room!.id,
      agentId: agent!.id,
      runId: agent!.id,
      nextTime: () => new Date(),
      emittedMessages: [],
      emit: async () => {},
    };

    // A long bubble is delivered: rejecting it cost a full model step to retype.
    const long = await executeSendMessage(ctx, { blocks: [{ kind: "text", markdown: "x".repeat(1201) }] });
    expect(long).toMatchObject({ messageId: expect.any(String) });

    const secret = (await executeSendMessage(ctx, {
      blocks: [{ kind: "widget", widget: "secret", props: { envName: "API_KEY", title: "Key" } }],
    })) as { endedTurn?: boolean };
    expect(secret.endedTurn).toBe(true);
    expect(ctx.endTurn).toBe(true);
  });
});
