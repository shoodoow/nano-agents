import { expect, test } from "vitest";
import { buildCron, createCore, formatSchedule, routineTitle } from "./api";

test("auto-review settings and tool approvals round-trip", async () => {
  const pending = [
    { id: "t1", agentId: "a", conversationId: "c", tool: "bash", summary: "rm -rf /tmp", status: "pending" },
  ];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/accounts/account/settings") && init?.method === "PATCH") {
      expect(JSON.parse(String(init.body))).toEqual({ autoReview: false });
      return new Response(JSON.stringify({ autoReview: false }), { status: 200 });
    }
    if (url.endsWith("/accounts/account/settings")) {
      return new Response(JSON.stringify({ autoReview: true }), { status: 200 });
    }
    if (url.includes("/tool-approvals/t1/approve") && init?.method === "POST") {
      pending.splice(0, pending.length);
      return new Response(JSON.stringify({ id: "t1", status: "approved" }), { status: 200 });
    }
    if (url.endsWith("/accounts/account/tool-approvals")) {
      return new Response(JSON.stringify(pending), { status: 200 });
    }
    return new Response("missing", { status: 404 });
  };
  const core = createCore("http://core.example", fetchImpl);
  expect(await core.getSettings("account")).toEqual({ autoReview: true });
  expect(await core.setAutoReview("account", false)).toEqual({ autoReview: false });
  expect(await core.listToolApprovals("account")).toHaveLength(1);
  const after = await core.approveTool("account", "t1");
  expect(after).toEqual([]);
});

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

test("routines round-trip over the agent endpoints", async () => {
  const routines = [
    {
      id: "r1",
      title: "License sale",
      instructions: "Sell the license",
      cron: "32 9 * * 1-5",
      timezone: "UTC",
      paused: false,
    },
  ];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/agents/a1/routines?accountId=account-1") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { cron: string; title: string };
      expect(body.cron).toBe("32 9 * * 1-5");
      expect(body.title).toBe("License sale");
      return new Response(JSON.stringify({ ...routines[0], id: "r2" }), { status: 201 });
    }
    if (url.endsWith("/agents/a1/routines?accountId=account-1")) {
      return new Response(JSON.stringify(routines), { status: 200 });
    }
    if (url.endsWith("/agents/a1/routines/r1?accountId=account-1") && init?.method === "PATCH") {
      return new Response(JSON.stringify({ ...routines[0], paused: true }), { status: 200 });
    }
    if (url.endsWith("/agents/a1/routines/r1?accountId=account-1") && init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return new Response("missing", { status: 404 });
  };
  const core = createCore("http://core.example", fetchImpl);
  await expect(core.listRoutines("account-1", "a1")).resolves.toHaveLength(1);
  const created = await core.createRoutine("account-1", "a1", {
    conversationId: "c1",
    title: "License sale",
    instructions: "Sell the license",
    cron: "32 9 * * 1-5",
  });
  expect(created.id).toBe("r2");
  const updated = await core.updateRoutine("account-1", "a1", "r1", { paused: true });
  expect(updated.paused).toBe(true);
  await expect(core.deleteRoutine("account-1", "a1", "r1")).resolves.toBeUndefined();
});

test("schedules read the way the bot info page shows them", () => {
  expect(formatSchedule("32 9 * * 1-5")).toBe("Weekdays at 9:32 AM");
  expect(formatSchedule("11 10 * * *")).toBe("Every day at 10:11 AM");
  expect(formatSchedule("14 16 * * 1")).toBe("Every Monday at 4:14 PM");
  expect(formatSchedule("12 17 * * *")).toBe("Every day at 5:12 PM");
  expect(formatSchedule("*/15 * * * *")).toBe("Every 15 minutes");
  expect(formatSchedule("0 0 * * 0")).toBe("Every Sunday at 12:00 AM");
  expect(formatSchedule("nonsense")).toBe("nonsense");
  expect(formatSchedule("0 9 1 * *")).toBe("0 9 1 * *");
  expect(buildCron("daily", 10, 11)).toBe("11 10 * * *");
  expect(buildCron("weekdays", 9, 32)).toBe("32 9 * * 1-5");
  expect(buildCron(1, 16, 14)).toBe("14 16 * * 1");
  expect(routineTitle("Sell the license\nRun the weekday check.")).toBe("Sell the license");
  expect(routineTitle("")).toBe("Untitled routine");
  expect(routineTitle({ title: "Octessa IG afternoon post", instructions: "Post at 4." })).toBe(
    "Octessa IG afternoon post",
  );
});

test("vault secrets post the name and value without echoing them back", async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/accounts/account-1/secrets") && init?.method === "POST") {
      expect(JSON.parse(String(init.body))).toEqual({ name: "CMO_PASSWORD", secret: "s3cr3t" });
      return new Response(JSON.stringify({ name: "CMO_PASSWORD", configured: true }), { status: 201 });
    }
    return new Response("missing", { status: 404 });
  };
  const core = createCore("http://core.example", fetchImpl);
  await expect(core.saveSecret("account-1", { name: "CMO_PASSWORD", secret: "s3cr3t" })).resolves.toEqual({
    name: "CMO_PASSWORD",
    configured: true,
  });
});

test("the screen url is the core websocket", () => {
  const core = createCore("http://127.0.0.1:3000");
  expect(core.screenUrl("account", "uabc")).toBe("ws://127.0.0.1:3000/accounts/account/screens/uabc");
});

test("the screen page and its socket share one origin so the cookie is sent", () => {
  const plain = createCore("http://127.0.0.1:3000");
  const page = new URL(plain.screenPageUrl("account", "uabc"));
  const socket = new URL(plain.screenUrl("account", "uabc"));
  expect(page.origin).toBe(socket.origin.replace(/^ws/, "http"));
  expect(page.pathname).toBe("/accounts/account/screens/uabc/client");

  const secure = createCore("https://core.example");
  expect(secure.screenPageUrl("account", "uabc")).toBe("https://core.example/accounts/account/screens/uabc/client");
  expect(secure.screenUrl("account", "uabc")).toBe("wss://core.example/accounts/account/screens/uabc");
});

test("the screen page escapes a profile that needs it", () => {
  const core = createCore("http://127.0.0.1:3000");
  expect(core.screenPageUrl("account", "u abc")).toBe("http://127.0.0.1:3000/accounts/account/screens/u%20abc/client");
});

test("the stream resumes from a cursor and devices register", async () => {
  const seen: string[] = [];
  const sse = `data: {"type":"message","message":{"id":"m2"},"cursor":42,"conversationId":"c1"}\n\n`;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    seen.push(url);
    if (url.includes("/stream")) {
      return new Response(sse, { status: 200 });
    }
    if (url.endsWith("/devices?accountId=a1")) {
      expect(JSON.parse(String(init?.body))).toEqual({
        expoPushToken: "ExponentPushToken[x]",
        platform: "ios",
      });
      return new Response(JSON.stringify({ id: "d1" }), { status: 200 });
    }
    if (url.includes("/notifications")) {
      return new Response(JSON.stringify([{ id: "n1" }]), { status: 200 });
    }
    return new Response("missing", { status: 404 });
  };
  const core = createCore("http://core.example", fetchImpl);
  const events: { cursor?: number }[] = [];
  const stop = core.subscribeMessages("a1", "c1", (event) => events.push(event), { cursor: 41 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  stop();
  expect(seen.some((url) => url.includes("cursor=41"))).toBe(true);
  expect(events[0]).toMatchObject({ cursor: 42 });
  await expect(core.registerDevice("a1", { expoPushToken: "ExponentPushToken[x]", platform: "ios" })).resolves.toEqual({
    id: "d1",
  });
  await expect(core.listNotifications("a1")).resolves.toHaveLength(1);
});
