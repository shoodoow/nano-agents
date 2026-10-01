import { describe, expect, it } from "vitest";
import { sendMessageInputSchema } from "@nano-agents/shared";

describe("send_message tool shape", () => {
  it("accepts canonical text blocks", () => {
    const parsed = sendMessageInputSchema.safeParse({
      blocks: [{ kind: "text", markdown: "Still processing the desktop screenshot..." }],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects blocks missing kind (model failure mode from traces)", () => {
    const parsed = sendMessageInputSchema.safeParse({
      blocks: [{ "": "Still processing the desktop screenshot..." }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects text field without kind markdown", () => {
    expect(sendMessageInputSchema.safeParse({ blocks: [{ kind: "text", text: "hi" }] }).success).toBe(false);
    expect(sendMessageInputSchema.safeParse({ blocks: [{ text: "hi" }] }).success).toBe(false);
  });
});
