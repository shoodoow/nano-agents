/**
 * JSON Schema for send_message tool input — must match @nano-agents/shared Zod blocks.
 * Why: a bare blocks: array lets the model invent keys like {"": "..."}; oneOf on kind
 * is what providers surface to the model at tool-call time.
 */
export const messageBlockToolJsonSchema = {
  oneOf: [
    {
      type: "object",
      description: "Plain text the person reads (most messages use this only).",
      properties: {
        kind: { type: "string", const: "text" },
        markdown: { type: "string", minLength: 1, description: "Message body (markdown or plain sentences)." },
      },
      required: ["kind", "markdown"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", const: "image" },
        url: { type: "string", minLength: 1, description: "https URL or data:image/*;base64 URI." },
        alt: { type: "string" },
      },
      required: ["kind", "url"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", const: "code" },
        language: { type: "string" },
        code: { type: "string", minLength: 1 },
      },
      required: ["kind", "code"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", const: "file" },
        url: { type: "string", minLength: 1 },
        name: { type: "string", minLength: 1 },
        mime: { type: "string" },
      },
      required: ["kind", "url", "name"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", const: "widget" },
        widget: { type: "string", enum: ["checklist", "chart", "approval", "agent-card"] },
        props: { type: "object", additionalProperties: true },
      },
      required: ["kind", "widget", "props"],
      additionalProperties: false,
    },
  ],
} as const;

export const sendMessageToolJsonSchema = {
  type: "object",
  description: 'Wrap text in blocks: [{ "kind": "text", "markdown": "..." }].',
  properties: {
    blocks: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      description: "One or more message blocks. Each item must include kind.",
      items: messageBlockToolJsonSchema,
    },
    replyTo: {
      type: ["string", "null"],
      description: "Optional message UUID when replying to a specific bubble.",
    },
  },
  required: ["blocks"],
  additionalProperties: false,
} as const;

