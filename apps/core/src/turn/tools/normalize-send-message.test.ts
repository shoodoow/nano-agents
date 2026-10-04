import { describe, expect, it } from "vitest";
import { sendMessageInputSchema } from "@nano-agents/agent-tools";
import { normalizeSendMessageInput, stripInternalChatMarks } from "./normalize-send-message.js";

describe("normalizeSendMessageInput", () => {
  it("strips message ids and worker labels before they reach chat", () => {
    expect(stripInternalChatMarks("[msg:7adfdcc1-c99e-4660-9d56-6d673bf6e842]\nFindings: hello")).toBe("hello");
    const n = normalizeSendMessageInput({
      blocks: [{ kind: "text", markdown: "[msg:abc-123]\nOn it." }],
    });
    expect(n.blocks).toEqual([{ kind: "text", markdown: "On it." }]);
  });

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

  it("expands dumped [widget:…] markdown into real widget blocks", () => {
    const raw = {
      blocks: [
        {
          kind: "text",
          markdown: '[widget:secret {"envName": "TEST_SECRET_TOKEN", "hint": "Enter a test value"}]',
        },
      ],
    };
    const n = normalizeSendMessageInput(raw);
    expect(sendMessageInputSchema.safeParse(n).success).toBe(true);
    expect(n.blocks).toEqual([
      {
        kind: "widget",
        widget: "secret",
        props: { envName: "TEST_SECRET_TOKEN", hint: "Enter a test value" },
      },
    ]);
  });

  it("expands dumped question markup", () => {
    const raw = {
      blocks: [
        {
          kind: "text",
          markdown:
            '[widget:question {"prompt": "When?", "options": [{"label": "Morning", "value": "morning"}]}]',
        },
      ],
    };
    const n = normalizeSendMessageInput(raw);
    const parsed = sendMessageInputSchema.safeParse(n);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.blocks[0]).toMatchObject({
      kind: "widget",
      widget: "question",
      props: { prompt: "When?" },
    });
  });
});
