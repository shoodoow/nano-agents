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
