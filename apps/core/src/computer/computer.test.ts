import { afterAll, expect, test } from "vitest";
import { getDb } from "../db/client.js";
import { createAgent, createAccount } from "../roster/roster.js";
import { createProfile, removeAccountContainers } from "../linux/linux.js";
import { bash, readFile, writeFile } from "./computer.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/nano_agents";
const db = getDb(databaseUrl);

afterAll(async () => {
  await removeAccountContainers();
  await db.$client.end();
});

test("shares a file and refuses another home", async () => {
  const account = await createAccount(db, { name: "Desk" });
  const ada = await createAgent(db, account.id, hired("Ada"));
  const bea = await createAgent(db, account.id, hired("Bea"));
  const adaUser = await createProfile(db, account.id, ada.id);
  const beaUser = await createProfile(db, account.id, bea.id);
  await writeFile(account.id, adaUser, "/shared/note", "hello");
  await expect(readFile(account.id, beaUser, "/shared/note")).resolves.toBe("hello");
  await writeFile(account.id, adaUser, `/home/${adaUser}/secret`, "private");
  await expect(readFile(account.id, beaUser, `/home/${adaUser}/secret`)).rejects.toThrow(/outside/);
  await expect(bash(account.id, beaUser, "whoami")).resolves.toBe(`${beaUser}\n`);
});

function hired(name: string) {
  return {
    name,
    label: name,
    description: `${name} writes files.`,
    provider: "openai",
    modelId: "gpt-5",
  };
}
