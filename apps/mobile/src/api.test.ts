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

test("the screen url is the core websocket", () => {
  const core = createCore("http://127.0.0.1:3000");
  expect(core.screenUrl("account", "uabc")).toBe("ws://127.0.0.1:3000/accounts/account/screens/uabc");
});
