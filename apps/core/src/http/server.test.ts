import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../db/client.js";
import { textOf } from "../rooms/turn.js";
import { startServer } from "./server.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/nano_agents";
const db = getDb(databaseUrl);
const systemPrompt = readFileSync(new URL("../../../../prompts/system.md", import.meta.url), "utf8").trim();

describe("server", () => {
  let baseUrl = "";
  let closeServer: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const server = await startServer(db, 0, async ({ messages }) => {
      const mentionedBea = messages.some((message) => textOf(message.content).includes("@Bea"));
      return mentionedBea ? "finished" : "@Bea your turn";
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    closeServer = () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
  });

  afterAll(async () => {
    await closeServer?.();
    await db.$client.end();
  });

  it("answers the local Expo web preflight", async () => {
    const response = await fetch(`${baseUrl}/api/auth/get-session`, {
      method: "OPTIONS",
      headers: {
        origin: "http://127.0.0.1:8081",
        "access-control-request-method": "GET",
        "access-control-request-headers": "content-type",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:8081");
  });

  it("hires an agent, updates pin, and returns a prompt that starts with identity", async () => {
    const accountResponse = await fetch(`${baseUrl}/accounts`, {
      method: "POST",
      body: JSON.stringify({ name: "Desk" }),
    });
    const account = (await accountResponse.json()) as { id: string };
    const agentResponse = await fetch(`${baseUrl}/accounts/${account.id}/agents`, {
      method: "POST",
      body: JSON.stringify({
        name: "Ada",
        label: "Books",
        description: "Keep the ledger.",
        provider: "openai",
        modelId: "gpt-5",
      }),
    });
    const agent = (await agentResponse.json()) as { id: string; linuxProfile: string | null };
    expect(agent.linuxProfile).toBeNull();

    const patched = await fetch(`${baseUrl}/agents/${agent.id}?accountId=${account.id}`, {
      method: "PATCH",
      body: JSON.stringify({ notify: true, pinned: true, hidden: false }),
    });
    expect(await patched.json()).toMatchObject({ pinned: true });

    const prompt = await fetch(`${baseUrl}/agents/${agent.id}/prompt?accountId=${account.id}`);
    const body = (await prompt.json()) as { prompt: string };
    expect(body.prompt.indexOf(systemPrompt)).toBe(0);
    expect(body.prompt.endsWith("Keep the ledger.")).toBe(true);

    const other = await fetch(`${baseUrl}/accounts`, {
      method: "POST",
      body: JSON.stringify({ name: "Other" }),
    });
    const second = (await other.json()) as { id: string };
    const hidden = await fetch(`${baseUrl}/agents/${agent.id}?accountId=${second.id}`);
    expect(hidden.status).toBe(404);
  });

  it("stores a mentioned reply and the agent that reply mentions, in order", async () => {
    const account = await postJson<{ id: string }>(`${baseUrl}/accounts`, { name: "Group" });
    const ada = await postJson<{ id: string }>(`${baseUrl}/accounts/${account.id}/agents`, agent("Ada"));
    const bea = await postJson<{ id: string }>(`${baseUrl}/accounts/${account.id}/agents`, agent("Bea"));
    const room = await postJson<{ id: string }>(`${baseUrl}/accounts/${account.id}/conversations`, {
      kind: "group",
      title: "desk",
      ownerAgentId: ada.id,
      memberAgentIds: [ada.id, bea.id],
    });
    const sent = await fetch(`${baseUrl}/conversations/${room.id}/messages?accountId=${account.id}&sync=1`, {
      method: "POST",
      body: JSON.stringify({ body: "@Ada start" }),
    });
    const stored = (await sent.json()) as { replies: { agentId: string; body: string }[] };
    expect(sent.status).toBe(201);
    expect(stored.replies.map((reply) => reply.agentId)).toEqual([ada.id, bea.id]);
    expect(stored.replies.map((reply) => reply.body)).toEqual(["@Bea your turn", "finished"]);

    const other = await postJson<{ id: string }>(`${baseUrl}/accounts`, { name: "Outsider" });
    const blocked = await fetch(`${baseUrl}/conversations/${room.id}/messages?accountId=${other.id}&sync=1`, {
      method: "POST",
      body: JSON.stringify({ body: "@Ada start" }),
    });
    expect(blocked.status).toBe(404);
  });

  it("persists the user message before the background turn (never vanishes)", async () => {
    const account = await postJson<{ id: string }>(`${baseUrl}/accounts`, { name: "Durable" });
    const ada = await postJson<{ id: string }>(`${baseUrl}/accounts/${account.id}/agents`, agent("Ada"));
    const room = await postJson<{ id: string }>(`${baseUrl}/accounts/${account.id}/conversations`, {
      kind: "direct",
      title: "desk",
      ownerAgentId: ada.id,
      memberAgentIds: [ada.id],
    });
    const sent = await fetch(`${baseUrl}/conversations/${room.id}/messages?accountId=${account.id}`, {
      method: "POST",
      body: JSON.stringify({ body: "check octessa.com SEO" }),
    });
    expect(sent.status).toBe(202);
    const accepted = (await sent.json()) as { message: { id: string; body: string } };
    expect(accepted.message.body).toBe("check octessa.com SEO");
    // The message is durable immediately — a refresh racing the turn finds it.
    const thread = (await (
      await fetch(`${baseUrl}/conversations/${room.id}/messages?accountId=${account.id}`)
    ).json()) as { id: string }[];
    expect(thread.map((row) => row.id)).toContain(accepted.message.id);
  });

  it("accepts multi-megabyte image attachments (no 413)", async () => {
    const account = await postJson<{ id: string }>(`${baseUrl}/accounts`, { name: "Large" });
    const ada = await postJson<{ id: string }>(`${baseUrl}/accounts/${account.id}/agents`, agent("Ada"));
    const room = await postJson<{ id: string }>(`${baseUrl}/accounts/${account.id}/conversations`, {
      kind: "direct",
      title: "desk",
      ownerAgentId: ada.id,
      memberAgentIds: [ada.id],
    });
    const big = `data:image/png;base64,${"A".repeat(2_000_000)}`;
    const sent = await fetch(`${baseUrl}/conversations/${room.id}/messages?accountId=${account.id}`, {
      method: "POST",
      body: JSON.stringify({ blocks: [{ kind: "image", url: big, alt: "photo" }] }),
    });
    expect(sent.status).toBe(202);
    const accepted = (await sent.json()) as { message: { id: string } };
    expect(accepted.message.id).toBeDefined();
  });

  it("rejects a 21st member", async () => {
    const account = await postJson<{ id: string }>(`${baseUrl}/accounts`, { name: "Full" });
    const hired = [];
    for (let index = 0; index < 20; index += 1) {
      hired.push(await postJson<{ id: string }>(`${baseUrl}/accounts/${account.id}/agents`, agent(`M${index}`)));
    }
    const room = await postJson<{ id: string }>(`${baseUrl}/accounts/${account.id}/conversations`, {
      kind: "group",
      title: "full",
      ownerAgentId: hired[0]!.id,
      memberAgentIds: hired.map((member) => member.id),
    });
    const extra = await postJson<{ id: string }>(`${baseUrl}/accounts/${account.id}/agents`, agent("Extra"));
    const rejected = await fetch(`${baseUrl}/conversations/${room.id}/members?accountId=${account.id}`, {
      method: "POST",
      body: JSON.stringify({ agentId: extra.id }),
    });
    expect(rejected.status).toBe(409);
  });
});

function agent(name: string) {
  return {
    name,
    label: name,
    description: `${name} works here.`,
    provider: "openai",
    modelId: "gpt-5",
  };
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, { method: "POST", body: JSON.stringify(body) });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as T;
}
