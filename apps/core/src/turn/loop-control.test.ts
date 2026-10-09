import { describe, expect, it } from "vitest";
import { promisesUnstartedWork,
  replyOnlyRestriction, shouldEndTurn } from "./loop-control.js";

const base = { handedOff: false, sentMessage: false, hiddenTurn: false };

describe("shouldEndTurn", () => {
  it("keeps going after an opening ack so the work can start", () => {
    expect(shouldEndTurn({ ...base, sentMessage: true, stepToolNames: [["send_message"]] })).toBe(false);
  });

  it("ends once a worker is running and the person has a bubble", () => {
    expect(
      shouldEndTurn({ ...base, handedOff: true, sentMessage: true, stepToolNames: [["send_message", "spawn_worker"]] }),
    ).toBe(true);
  });

  it("does not end a person-opened turn silent after a handoff", () => {
    expect(shouldEndTurn({ ...base, handedOff: true, stepToolNames: [["spawn_worker"]] })).toBe(false);
  });

  it("lets a hidden wake hand off without a bubble", () => {
    expect(shouldEndTurn({ ...base, handedOff: true, hiddenTurn: true, stepToolNames: [["spawn_worker"]] })).toBe(true);
  });

  it("ends when the answer is sent after earlier lookups", () => {
    expect(
      shouldEndTurn({ ...base, sentMessage: true, stepToolNames: [["send_message"], ["web_search"], ["send_message"]] }),
    ).toBe(true);
  });

  it("keeps going when a bubble and a lookup share one step", () => {
    expect(
      shouldEndTurn({ ...base, sentMessage: true, stepToolNames: [["read"], ["send_message", "web_fetch"]] }),
    ).toBe(false);
  });
});

describe("replyOnlyRestriction", () => {
  it("leaves normal steps open", () => {
    expect(replyOnlyRestriction({ ...base, finishedSteps: 1, maxSteps: 6 })).toBeNull();
  });

  it("closes the last step to replying or handing off", () => {
    expect(replyOnlyRestriction({ ...base, finishedSteps: 5, maxSteps: 6 })?.activeTools).toEqual([
      "send_message",
      "spawn_worker",
      "delegate",
    ]);
  });

  it("does not count team setup steps against the budget", () => {
    const setup = [["enable_tools"], ["create_group"], ["hire_subagent"], ["hire_subagent"]];
    expect(replyOnlyRestriction({ ...base, finishedSteps: 4, maxSteps: 5, stepToolNames: setup })).toBeNull();
    const research = [["web_search"], ["read"], ["glob"], ["read"]];
    expect(replyOnlyRestriction({ ...base, finishedSteps: 4, maxSteps: 5, stepToolNames: research })).not.toBeNull();
  });

  it("asks for an ack right after a silent handoff", () => {
    expect(replyOnlyRestriction({ ...base, handedOff: true, finishedSteps: 1, maxSteps: 6 })?.activeTools).toEqual([
      "send_message",
    ]);
  });

  it("leaves steps open after a bubble, but still closes the last one", () => {
    expect(replyOnlyRestriction({ ...base, sentMessage: true, finishedSteps: 2, maxSteps: 6 })).toBeNull();
    expect(replyOnlyRestriction({ ...base, sentMessage: true, finishedSteps: 5, maxSteps: 6 })?.activeTools).toContain(
      "spawn_worker",
    );
  });
});

describe("promisesUnstartedWork", () => {
  const open = { handedOff: false, hiddenTurn: false };

  it("spots a promise with nothing started", () => {
    expect(promisesUnstartedWork({ ...open, text: "Understood. Let me stop the audio and get the render going." })).toBe(true);
    expect(promisesUnstartedWork({ ...open, text: "I'll build it now." })).toBe(true);
  });

  it("ignores answers, questions, and turns that already handed off", () => {
    expect(promisesUnstartedWork({ ...open, text: "It is 4pm in Riyadh." })).toBe(false);
    expect(promisesUnstartedWork({ ...open, text: "I'll build it. Want music too?" })).toBe(false);
    expect(promisesUnstartedWork({ handedOff: true, hiddenTurn: false, text: "I'll have it soon." })).toBe(false);
    expect(promisesUnstartedWork({ handedOff: false, hiddenTurn: true, text: "Let me fix that." })).toBe(false);
  });
});

describe("finalTextIsReply", () => {
  it("posts text when no bubble was sent", async () => {
    const { finalTextIsReply } = await import("./loop-control.js");
    expect(finalTextIsReply([["web_search"], []])).toBe(true);
  });

  it("posts the answer that follows an ack and a lookup", async () => {
    const { finalTextIsReply } = await import("./loop-control.js");
    expect(finalTextIsReply([["send_message"], ["read"], []])).toBe(true);
  });

  it("drops a sign-off that follows the last bubble with no work", async () => {
    const { finalTextIsReply } = await import("./loop-control.js");
    expect(finalTextIsReply([["read"], ["send_message"], []])).toBe(false);
  });
});
