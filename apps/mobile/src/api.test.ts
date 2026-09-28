import { expect, test } from "vitest";
import { createCore } from "./api";

test("approve refreshes the list without the decided proposal", async () => {
  const pending = [{ id: "p1", agentId: "a", kind: "memory", body: "Remember the gate.", status: "pending" }];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/approve") && init?.method === "POST") {
      pending.splice(0, pending.length);
      return new Response(JSON.stringify({ id: "p1", status: "approved" }), { status: 200 });
    }
    if (url.includes("/proposals")) {
      return new Response(JSON.stringify(pending), { status: 200 });
    }
    return new Response("missing", { status: 404 });
  };
  const core = createCore("http://core.example", fetchImpl);
  expect(await core.listProposals("account")).toHaveLength(1);
  const after = await core.approve("account", "p1");
  expect(after.find((proposal) => proposal.id === "p1")).toBeUndefined();
});

test("provider saves only return safe metadata", async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/accounts/account-1/providers") && init?.method === "PUT") {
      expect(JSON.parse(String(init.body))).toEqual({ provider: "openai", secret: "sk-private", baseUrl: null });
      return new Response(JSON.stringify({ provider: "openai", configured: true, baseUrl: null }), { status: 200 });
    }
    return new Response("missing", { status: 404 });
  };
  const core = createCore("http://core.example", fetchImpl);
  await expect(
    core.saveProvider("account-1", { provider: "openai", secret: "sk-private", baseUrl: null }),
  ).resolves.toEqual({ provider: "openai", configured: true, baseUrl: null });
});

test("a group is created on the signed-in account", async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/accounts/account-1/conversations") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { kind: string; ownerAgentId: string };
      expect(body.kind).toBe("group");
      expect(body.ownerAgentId).toBe("11111111-1111-4111-8111-111111111111");
      return new Response(JSON.stringify({ id: "room-1" }), { status: 201 });
    }
    return new Response("missing", { status: 404 });
  };
  const core = createCore("http://core.example", fetchImpl);
  const room = await core.createGroup("account-1", "Evening", [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ]);
  expect(room.id).toBe("room-1");
});

test("the screen url is the core websocket", () => {
  const core = createCore("http://127.0.0.1:3000");
  expect(core.screenUrl("account", "uabc")).toBe("ws://127.0.0.1:3000/accounts/account/screens/uabc");
});
