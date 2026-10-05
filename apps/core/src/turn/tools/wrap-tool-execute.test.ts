import { describe, expect, it } from "vitest";
import { personTurnBlocksTool, PERSON_TURN_REPLY_FIRST_ERROR } from "./wrap-tool-execute.js";
import type { ToolContext } from "./context.js";

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    db: null as never,
    store: null as never,
    accountId: "a",
    conversationId: "c",
    agentId: "g",
    runId: "r",
    nextTime: () => new Date(),
    emittedMessages: [],
    emit: async () => {},
    ...overrides,
  };
}

describe("person-turn reply-first gate", () => {
  it("blocks spawn_worker until send_message on a person turn", () => {
    const toolCtx = ctx({ personTurn: true, userReplySent: false });
    expect(personTurnBlocksTool(toolCtx, "dispatcher", "spawn_worker")).toBe(true);
    expect(personTurnBlocksTool(toolCtx, "dispatcher", "send_message")).toBe(false);
  });

  it("allows any tool after send_message", () => {
    const toolCtx = ctx({ personTurn: true, userReplySent: true });
    expect(personTurnBlocksTool(toolCtx, "dispatcher", "spawn_worker")).toBe(false);
    expect(personTurnBlocksTool(toolCtx, "dispatcher", "todo_write")).toBe(false);
  });

  it("does not apply to worker cue turns or delegate mode", () => {
    const toolCtx = ctx({ personTurn: false, userReplySent: false });
    expect(personTurnBlocksTool(toolCtx, "dispatcher", "spawn_worker")).toBe(false);
    expect(personTurnBlocksTool(ctx({ personTurn: true }), "worker", "bash")).toBe(false);
  });

  it("documents the model-facing error", () => {
    expect(PERSON_TURN_REPLY_FIRST_ERROR).toMatch(/send_message/i);
  });
});
