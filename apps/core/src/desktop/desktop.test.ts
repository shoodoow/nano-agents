import { afterAll, expect, test } from "vitest";
import { getDb } from "../db/client.js";
import { createAgent, createAccount } from "../roster/roster.js";
import { createProfile, removeAccountContainers } from "../linux/linux.js";
import { mouse, screenshot, startDesktop } from "./desktop.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/nano_agents";
const db = getDb(databaseUrl);

afterAll(async () => {
  await removeAccountContainers();
  await db.$client.end();
});

test("a pointer move changes the screenshot", async () => {
  const account = await createAccount(db, { name: "Screen" });
  const ada = await createAgent(db, account.id, hired("Ada"));
  const profile = await createProfile(db, account.id, ada.id);
  await startDesktop(account.id, profile);
  const before = await screenshot(account.id, profile);
  await mouse(account.id, profile, 200, 80);
  const after = await screenshot(account.id, profile);
  expect(Buffer.compare(before, after)).not.toBe(0);
});

function hired(name: string) {
  return {
    name,
    label: name,
    description: `${name} uses the desktop.`,
    provider: "openai",
    modelId: "gpt-5",
  };
}
