import { z } from "zod";

export const accountSchema = z.object({
  name: z.string().trim().min(1).max(100),
});

export const providerNames = ["openai", "anthropic", "xai", "local"] as const;

export const providerKeySchema = z
  .object({
    provider: z.enum(providerNames),
    secret: z.string().max(16_384),
    baseUrl: z.string().url().max(2_048).nullable().optional(),
  })
  .superRefine((value, context) => {
    if (value.provider === "local" && !value.baseUrl) {
      context.addIssue({ code: "custom", message: "A local provider needs a base URL." });
    }
    if (value.provider !== "local" && value.secret.trim().length === 0) {
      context.addIssue({ code: "custom", message: "The API key is required." });
    }
  });

export type ProviderKey = z.infer<typeof providerKeySchema>;

export const agentCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(10_000),
  provider: z.enum(providerNames),
  modelId: z.string().trim().min(1).max(200),
});

export const agentFlagsSchema = z.object({
  notify: z.boolean(),
  pinned: z.boolean(),
  hidden: z.boolean(),
});

export const agentProfileSchema = agentFlagsSchema.extend({
  name: z.string().trim().min(1).max(100).optional(),
  label: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().min(1).max(10_000).optional(),
});

export type Account = z.infer<typeof accountSchema>;
export type AgentCreate = z.infer<typeof agentCreateSchema>;
export type AgentFlags = z.infer<typeof agentFlagsSchema>;
export type AgentProfile = z.infer<typeof agentProfileSchema>;

export const roomCreateSchema = z.object({
  kind: z.enum(["direct", "group"]),
  title: z.string().trim().min(1).max(200),
  ownerAgentId: z.string().uuid(),
  memberAgentIds: z.array(z.string().uuid()).max(20),
});

export const messageCreateSchema = z.object({
  body: z.string().trim().min(1).max(100_000),
});

// --- Rich turn protocol (Phase 08): blocks, send_message input, reactions ---

export const textBlockSchema = z.object({
  kind: z.literal("text"),
  markdown: z.string().min(1).max(100_000),
});

export const blobRefSchema = z.object({
  messageId: z.string().uuid(),
  index: z.number().int().min(0).max(9),
});

export const imageBlockSchema = z.object({
  kind: z.literal("image"),
  // https URL or data:image/*;base64 URI (capped to keep rows + prompts bounded).
  url: z.string().min(1).max(8_000_000),
  alt: z.string().max(500).optional(),
  // Filled server-side when a data: URI is materialized onto the account
  // Linux: the agent opens/copies this path instead of the raw base64.
  savedPath: z.string().max(500).optional(),
  // Small resized data URI for vision grounding (full file stays on disk).
  previewUrl: z.string().max(1_000_000).optional(),
  // Set by listMessages when url/previewUrl exceed the inline budget: the
  // client fetches the bytes lazily from the blob endpoint instead.
  blobRef: blobRefSchema.optional(),
});

export const codeBlockSchema = z.object({
  kind: z.literal("code"),
  language: z.string().max(50).optional(),
  code: z.string().min(1).max(100_000),
});

export const fileBlockSchema = z.object({
  kind: z.literal("file"),
  // https URL or small data: URI (text, pdf, json — capped like images so a
  // phone attachment cannot blow up the row or the prompt).
  url: z.string().min(1).max(8_000_000),
  name: z.string().min(1).max(255),
  mime: z.string().max(127).optional(),
  // Filled server-side when a data: URI is materialized onto the account Linux.
  savedPath: z.string().max(500).optional(),
  // Set by listMessages when url exceeds the inline budget (see blobRefSchema).
  blobRef: blobRefSchema.optional(),
});

export const widgetBlockSchema = z.object({
  kind: z.literal("widget"),
  widget: z.enum(["checklist", "chart", "approval", "agent-card"]),
  // Validated per-widget on the client; kept loose on the wire for forward compat.
  props: z.record(z.string(), z.unknown()),
});

export const messageBlockSchema = z.discriminatedUnion("kind", [
  textBlockSchema,
  imageBlockSchema,
  codeBlockSchema,
  fileBlockSchema,
  widgetBlockSchema,
]);

export type MessageBlock = z.infer<typeof messageBlockSchema>;

export const sendMessageInputSchema = z
  .object({
    blocks: z.array(messageBlockSchema).min(1).max(10),
    replyTo: z.string().uuid().nullable().optional(),
  })
  .superRefine((value, context) => {
    const textChars = value.blocks
      .filter((block) => block.kind === "text")
      .map((block) => (block as { markdown: string }).markdown.length)
      .reduce((sum, length) => sum + length, 0);
    if (textChars > 100_000) {
      context.addIssue({ code: "custom", message: "Text blocks exceed 100k chars." });
    }
  });

export type SendMessageInput = z.infer<typeof sendMessageInputSchema>;

export const allowedEmojis = ["👍", "❤️", "👀", "🚀", "😮", "🎉", "✅", "❌"] as const;

export const reactionSchema = z.object({
  messageId: z.string().uuid(),
  emoji: z.enum(allowedEmojis),
});

export type ReactionInput = z.infer<typeof reactionSchema>;

// --- Teams / subagents (Phase 10) ---

export const subagentCreateSchema = z.object({
  label: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(10_000),
  provider: z.enum(providerNames).optional(),
  modelId: z.string().trim().min(1).max(200).optional(),
});

export type SubagentCreate = z.infer<typeof subagentCreateSchema>;

export const delegateSchema = z.object({
  agentId: z.string().uuid(),
  task: z.string().trim().min(1).max(20_000),
});

export type DelegateInput = z.infer<typeof delegateSchema>;

export const memberAddSchema = z.object({
  agentId: z.string().uuid(),
});

export type RoomCreate = z.infer<typeof roomCreateSchema>;
export type MessageCreate = z.infer<typeof messageCreateSchema>;
export type MemberAdd = z.infer<typeof memberAddSchema>;

export const summaryKeySchema = z.enum(["decisions", "actions", "open", "entities", "corrections", "topics"]);

export const summaryItemSchema = z.object({
  key: summaryKeySchema,
  body: z.string().min(1),
  messageId: z.string().uuid(),
});

export const memoryFactSchema = z
  .object({
    scope: z.enum(["agent", "user"]),
    agentId: z.string().uuid().nullable(),
    body: z.string().min(1),
    messageId: z.string().uuid(),
  })
  .superRefine((fact, context) => {
    if (fact.scope === "user" && fact.agentId !== null) {
      context.addIssue({ code: "custom", message: "A user fact has no agent." });
    }
    if (fact.scope === "agent" && fact.agentId === null) {
      context.addIssue({ code: "custom", message: "An agent fact needs an agent." });
    }
  });

export const memoryCorrectSchema = z
  .object({
    scope: z.enum(["agent", "user"]),
    agentId: z.string().uuid().nullable(),
    oldBody: z.string().min(1),
    body: z.string().min(1),
    messageId: z.string().uuid(),
  })
  .superRefine((fact, context) => {
    if (fact.scope === "user" && fact.agentId !== null) {
      context.addIssue({ code: "custom", message: "A user fact has no agent." });
    }
    if (fact.scope === "agent" && fact.agentId === null) {
      context.addIssue({ code: "custom", message: "An agent fact needs an agent." });
    }
  });

export type SummaryItem = z.infer<typeof summaryItemSchema>;
export type MemoryFact = z.infer<typeof memoryFactSchema>;
export type MemoryCorrect = z.infer<typeof memoryCorrectSchema>;

export const proposalSchema = z
  .object({
    agentId: z.string().uuid(),
    kind: z.enum(["memory", "skill", "prompt"]),
    body: z.string().min(1),
    messageIds: z.array(z.string().uuid()),
  })
  .superRefine((proposal, context) => {
    if (proposal.messageIds.length === 0) {
      context.addIssue({ code: "custom", message: "A proposal needs a message id." });
    }
  });

export type ProposalInput = z.infer<typeof proposalSchema>;

export const routineSchema = z.object({
  agentId: z.string().uuid(),
  conversationId: z.string().uuid(),
  body: z.string().min(1),
  cron: z.string().min(1),
  nextRunAt: z.string().min(1).optional(),
});

export type RoutineInput = z.infer<typeof routineSchema>;
