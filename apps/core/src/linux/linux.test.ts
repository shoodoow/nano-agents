import { afterAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { agents } from "../db/schema.js";
import { startServer } from "../http/server.js";
import { createAccount, createAgent } from "../roster/roster.js";
import { accountHome, accountShared, createProfile, exec, removeAccountContainers } from "./linux.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/nano_agents";
const db = getDb(databaseUrl);

describe("linux", () => {
  afterAll(async () => {
    await removeAccountContainers();
    await db.$client.end();
  });

  it("gives each account its own Linux", async () => {
    const first = await createAccount(db, { name: "One" });
    const second = await createAccount(db, { name: "Two" });
    const write = await exec(first.id, ["sh", "-c", `echo secret > ${accountShared(first.id)}/only-first`]);
    expect(write.code).toBe(0);
    const absent = await exec(second.id, ["sh", "-c", `test ! -f ${accountShared(second.id)}/only-first`]);
    expect(absent.code).toBe(0);
  });

  it("keeps homes private and shares /shared", async () => {
    const account = await createAccount(db, { name: "Profiles" });
    const ada = await createAgent(db, account.id, hired("Ada"));
    const bea = await createAgent(db, account.id, hired("Bea"));
    const adaUser = await createProfile(db, account.id, ada.id);
    const beaUser = await createProfile(db, account.id, bea.id);
    expect(adaUser).not.toBe(beaUser);

    const homeMode = await exec(account.id, ["stat", "-c", "%a", accountHome(account.id, adaUser)]);
    expect(homeMode.stdout.trim()).toBe("700");
    await exec(account.id, ["sh", "-c", `echo secret > ${accountHome(account.id, adaUser)}/secret`], adaUser);
    await exec(account.id, ["sh", "-c", `echo hello > ${accountShared(account.id)}/note && chmod a+r ${accountShared(account.id)}/note`], adaUser);
    const shared = await exec(account.id, ["cat", `${accountShared(account.id)}/note`], beaUser);
    expect(shared.stdout.trim()).toBe("hello");
    const hidden = await exec(account.id, ["cat", `${accountHome(account.id, adaUser)}/secret`], beaUser);
    expect(hidden.code).not.toBe(0);
  });

  it("creates one profile per member when a group is opened", async () => {
    const account = await createAccount(db, { name: "Group" });
    const ada = await createAgent(db, account.id, hired("Ada"));
    const bea = await createAgent(db, account.id, hired("Bea"));
    const server = await startServer(db, 0);
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/accounts/${account.id}/conversations`, {
      method: "POST",
      body: JSON.stringify({
        kind: "group",
        title: "desk",
        ownerAgentId: ada.id,
        memberAgentIds: [ada.id, bea.id],
      }),
    });
    expect(response.status).toBe(201);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    const rows = await db.select().from(agents).where(eq(agents.accountId, account.id));
    expect(rows.map((row) => row.linuxProfile).every((profile) => profile !== null)).toBe(true);
    expect(new Set(rows.map((row) => row.linuxProfile)).size).toBe(2);
  });
});

function hired(name: string) {
  return {
    name,
    label: name,
    description: `${name} works here.`,
    provider: "openai",
    modelId: "gpt-5",
  };
}
