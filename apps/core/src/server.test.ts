import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "./db/client.js";
import { startServer } from "./server.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/nano_agents";
const db = getDb(databaseUrl);
const identity = readFileSync(new URL("../../../prompts/identity.md", import.meta.url), "utf8").trim();

describe("server", () => {
  let baseUrl = "";
  let closeServer: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const server = await startServer(db, 0);
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
    expect(body.prompt.indexOf(identity)).toBe(0);
    expect(body.prompt.endsWith("Keep the ledger.")).toBe(true);

    const other = await fetch(`${baseUrl}/accounts`, {
      method: "POST",
      body: JSON.stringify({ name: "Other" }),
    });
    const second = (await other.json()) as { id: string };
    const hidden = await fetch(`${baseUrl}/agents/${agent.id}?accountId=${second.id}`);
    expect(hidden.status).toBe(404);
  });
});
