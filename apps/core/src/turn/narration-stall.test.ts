import { describe, expect, it } from "vitest";
import { isNarrationStall, shouldRetryStall, STALL_CHAR_CAP } from "./narration-stall.js";

describe("isNarrationStall", () => {
  it("flags next-step narration", () => {
    expect(isNarrationStall("Let me list the groups first.")).toBe(true);
    expect(isNarrationStall("I'll check routines in parallel.")).toBe(true);
    expect(isNarrationStall("I will tear everything down.")).toBe(true);
  });

  it("flags text over the character cap", () => {
    expect(isNarrationStall("x".repeat(STALL_CHAR_CAP + 1))).toBe(true);
  });

  it("allows a short finished reply", () => {
    expect(isNarrationStall("Done — Launch crew is cleared.")).toBe(false);
    expect(isNarrationStall("")).toBe(false);
  });
});

describe("shouldRetryStall", () => {
  it("retries once when the first step stalled", () => {
    expect(
      shouldRetryStall({
        attempt: 0,
        text: "Let me list everything.",
        sentMessage: false,
        ended: false,
      }),
    ).toBe(true);
  });

  it("retries once when the model returned empty text with no send_message", () => {
    expect(
      shouldRetryStall({
        attempt: 0,
        text: "",
        sentMessage: false,
        ended: false,
      }),
    ).toBe(true);
  });

  it("does not retry after a send_message, an ended turn, or a second attempt", () => {
    expect(
      shouldRetryStall({
        attempt: 0,
        text: "Let me list everything.",
        sentMessage: true,
        ended: false,
      }),
    ).toBe(false);
    expect(
      shouldRetryStall({
        attempt: 0,
        text: "",
        sentMessage: true,
        ended: false,
      }),
    ).toBe(false);
    expect(
      shouldRetryStall({
        attempt: 0,
        text: "Let me list everything.",
        sentMessage: false,
        ended: true,
      }),
    ).toBe(false);
    expect(
      shouldRetryStall({
        attempt: 1,
        text: "Let me list everything.",
        sentMessage: false,
        ended: false,
      }),
    ).toBe(false);
  });
});
