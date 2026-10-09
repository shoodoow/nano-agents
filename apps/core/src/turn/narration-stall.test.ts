import { describe, expect, it } from "vitest";
import { shouldRetryStall } from "./narration-stall.js";

describe("shouldRetryStall", () => {
  it("retries once when the model returned empty text with no send_message", () => {
    expect(shouldRetryStall({ attempt: 0, text: "", sentMessage: false, ended: false })).toBe(true);
    expect(shouldRetryStall({ attempt: 0, text: "   ", sentMessage: false, ended: false })).toBe(true);
  });

  it("treats plain text as a reply, whatever its wording or length", () => {
    expect(shouldRetryStall({ attempt: 0, text: "I'll let you know when it lands.", sentMessage: false, ended: false })).toBe(false);
    expect(shouldRetryStall({ attempt: 0, text: "x".repeat(5000), sentMessage: false, ended: false })).toBe(false);
  });

  it("does not retry after a send_message, an ended turn, or a second attempt", () => {
    expect(shouldRetryStall({ attempt: 0, text: "", sentMessage: true, ended: false })).toBe(false);
    expect(shouldRetryStall({ attempt: 0, text: "", sentMessage: false, ended: true })).toBe(false);
    expect(shouldRetryStall({ attempt: 1, text: "", sentMessage: false, ended: false })).toBe(false);
  });
});
