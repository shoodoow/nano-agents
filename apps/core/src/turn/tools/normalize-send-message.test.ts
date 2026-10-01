import { describe, expect, it } from "vitest";
import { sendMessageInputSchema } from "@nano-agents/shared";
import { normalizeSendMessageInput } from "./normalize-send-message.js";

describe("normalizeSendMessageInput", () => {
  it("wraps root-level kind/markdown (trace failure mode)", () => {
    const raw = { kind: "text", markdown: "On it." };
    const n = normalizeSendMessageInput(raw);
    expect(sendMessageInputSchema.safeParse(n).success).toBe(true);
  });

  it("parses blocks when sent as a JSON string", () => {
    const raw = { blocks: '[{"kind":"text","markdown":"hi"}]' };
    const n = normalizeSendMessageInput(raw);
    expect(sendMessageInputSchema.safeParse(n).success).toBe(true);
  });
});
