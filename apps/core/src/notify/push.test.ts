import { describe, expect, it, vi } from "vitest";
import { checkPushReceipts, sendExpoPush } from "./push.js";

/**
 * Locks the Expo Push sender: chunking, retry on 5xx, typed tickets, and
 * receipt verification — all against a mocked fetch, no credentials needed.
 */
describe("expo push sender", () => {
  it("chunks at 100, retries a 500, and returns tickets in order", async () => {
    const bodies: unknown[] = [];
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      calls += 1;
      bodies.push(JSON.parse(String(init?.body)));
      if (calls === 1) return new Response("err", { status: 500 });
      const chunk = (JSON.parse(String(init?.body)) as unknown[]).map((_, i) => ({ status: "ok", id: `ticket-${calls}-${i}` }));
      return new Response(JSON.stringify({ data: chunk }), { status: 200 });
    });
    const messages = [
      { to: "ExponentPushToken[a]", title: "t", body: "b" },
      { to: "ExponentPushToken[b]", title: "t", body: "b" },
    ];
    const tickets = await sendExpoPush(messages, fetchImpl as never);
    expect(tickets).toHaveLength(2);
    expect(tickets[0]).toMatchObject({ status: "ok" });
    expect(calls).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails fast on 4xx without retrying", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad", { status: 400 }));
    const tickets = await sendExpoPush([{ to: "bad", title: "t", body: "b" }], fetchImpl as never);
    expect(tickets[0]).toMatchObject({ status: "error" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("flags DeviceNotRegistered receipts and assumes missing ones sent", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ data: { t1: { status: "error", details: { error: "DeviceNotRegistered" } } } }),
        { status: 200 },
      ),
    );
    const receipts = await checkPushReceipts(["t1", "t2"], fetchImpl as never);
    expect(receipts.get("t1")).toMatchObject({ ok: false, error: "DeviceNotRegistered" });
    expect(receipts.get("t2")).toMatchObject({ ok: true });
  });
});
