import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "../db/client.js";
import { createAccount } from "../roster/roster.js";
import { exec, removeAccountContainers } from "./linux.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/nano_agents";
const db = getDb(databaseUrl);

describe("linux", () => {
  afterAll(async () => {
    await removeAccountContainers();
    await db.$client.end();
  });

  it("gives each account its own container", async () => {
    const first = await createAccount(db, { name: "One" });
    const second = await createAccount(db, { name: "Two" });
    const write = await exec(first.id, ["sh", "-c", "echo secret > /shared/only-first"]);
    expect(write.code).toBe(0);
    const absent = await exec(second.id, ["sh", "-c", "test ! -f /shared/only-first"]);
    expect(absent.code).toBe(0);
  });
});
