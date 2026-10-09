import {
  allowedEmojis,
  providerNames,
  sendMessageInputSchema,
  urgencySchema,
} from "@nano-agents/shared";
import { z } from "zod";

export { sendMessageInputSchema };

export const emptyToolInputSchema = z.object({});

export const memberAddInputSchema = z.object({
  agentId: z.string().uuid().describe("Existing teammate UUID from list_team. Not someone you just hired — hire_subagent already adds them."),
  /** Required from a private 1:1. Group id from create_group. */
  conversationId: z
    .string()
    .uuid()
    .optional()
    .describe("Group to add them to. Required when you are in a private 1:1. Omit when you are already in that group."),
});

/** @deprecated import name — same as memberAddInputSchema */
export const memberAddSchema = memberAddInputSchema;

export const workerRefInputSchema = z.object({
  workerId: z.string().uuid(),
});

export const workerRedirectInputSchema = z.object({
  workerId: z.string().uuid(),
  /** New steering instruction. Must be concrete (what to do differently), not a status question. */
  instruction: z.string().trim().min(20).max(2000),
});

export const groupCreateInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  memberIds: z.array(z.string().uuid()).max(19).optional().default([]),
});

export type GroupCreateInput = z.infer<typeof groupCreateInputSchema>;

/** Retry fields after Auto-review. Stripped from the input hash so approve-and-retry matches. */
const autoReviewRetryFields = {
  requestApproval: z.boolean().optional(),
  approvalId: z.string().uuid().optional(),
};

export const groupConversationInputSchema = z.object({
  conversationId: z.string().uuid(),
  /** Approval gate: destructive and irreversible — model must ask the person first, then re-call with confirmed:true. */
  confirmed: z.boolean().optional(),
  ...autoReviewRetryFields,
});

export type GroupConversationInput = z.infer<typeof groupConversationInputSchema>;

export const subagentCreateSchema = z.object({
  label: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe("A human first name you choose, such as Maya or Jordan. Never the job title."),
  role: z.string().trim().min(1).max(100).describe("The job title, such as SEO analyst. This is not their name."),
  personality: z.string().trim().max(500).optional().default(""),
  jobDescription: z.string().trim().min(1).max(10_000),
  provider: z.enum(providerNames).optional(),
  modelId: z.string().trim().min(1).max(200).optional(),
  /** Required when hiring from a private 1:1 — use conversationId from create_group. */
  conversationId: z.string().uuid().optional(),
});

export type SubagentCreate = z.infer<typeof subagentCreateSchema>;

export const teammateUpdateSchema = z.object({
  agentId: z.string().uuid().describe("Teammate UUID from list_team."),
  label: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe("New human first name, one word, such as Maya. Replaces their name. Never a job title."),
  role: z.string().trim().min(1).max(100).optional().describe("New job title. Not their name."),
  personality: z.string().trim().max(500).optional(),
  jobDescription: z
    .string()
    .trim()
    .min(1)
    .max(10_000)
    .optional()
    .describe("New standing instructions: what they own and how they should work."),
});

export type TeammateUpdate = z.infer<typeof teammateUpdateSchema>;

export const delegateSchema = z.object({
  agentId: z.string().uuid().describe("Teammate UUID from hire_subagent or list_team."),
  task: z.string().trim().min(1).max(20_000),
  /** Required when delegating from a private 1:1 — same id passed to hire_subagent. */
  conversationId: z
    .string()
    .uuid()
    .optional()
    .describe(
      "Group the teammate should speak in. Required from a private 1:1 — use the conversationId from create_group / hire_subagent. Omit when you are already in that group.",
    ),
});

export type DelegateInput = z.infer<typeof delegateSchema>;

export const notifyInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(1000),
  urgency: urgencySchema.optional().default("info"),
  messageId: z.string().uuid().nullable().optional(),
});

export type NotifyInput = z.infer<typeof notifyInputSchema>;

export const reactionSchema = z.object({
  messageId: z.string().uuid(),
  emoji: z.enum(allowedEmojis),
});

export type ReactionInput = z.infer<typeof reactionSchema>;

export const readHistoryToolInputSchema = z.object({
  messageId: z.string().uuid().optional(),
  search: z.string().optional(),
});

export const rememberFactToolInputSchema = z.object({
  scope: z.enum(["agent", "user"]),
  body: z.string().trim().min(3).max(1000),
  messageId: z.string().uuid(),
});

export const correctMemoryToolInputSchema = z.object({
  scope: z.enum(["agent", "user"]),
  oldBody: z.string().trim().min(3).max(1000),
  body: z.string().trim().min(3).max(1000),
  messageId: z.string().uuid(),
});

export const readSkillToolInputSchema = z.object({
  name: z.string().min(1),
});

export const workerKindNames = [
  "executor",
  "computer",
  "browser",
  "explore",
  "shell",
  "debug",
  "watch_video",
  "video_review",
  "vm_setup",
  "docs",
  "custom",
] as const;

export type WorkerKindName = (typeof workerKindNames)[number];

const spawnWorkerFields = {
  label: z.string().trim().min(1).max(100),
  role: z.string().trim().min(1).max(100),
  personality: z.string().trim().max(500).optional().default(""),
  jobDescription: z.string().trim().min(1).max(10_000),
  task: z.string().trim().min(1).max(20_000),
  /** Specialist standing method. Default computer (desktop-capable). Use custom + instructions when none fit. */
  kind: z.enum(workerKindNames).optional().default("computer"),
  /** Required when kind is custom: the standing method the worker follows. */
  instructions: z.string().trim().min(1).max(20_000).optional(),
  /** Step budget override (3-30). Default is 10 (18 for browser/computer). Raise only for multi-stage builds. */
  maxSteps: z.number().int().min(3).max(30).optional(),
  provider: z.enum(providerNames).optional(),
  modelId: z.string().trim().min(1).max(200).optional(),
};

function refineCustomWorkerKind(
  value: { kind?: string; instructions?: string },
  ctx: z.RefinementCtx,
) {
  if (value.kind === "custom" && !(value.instructions && value.instructions.trim())) {
    ctx.addIssue({
      code: "custom",
      message: "kind custom requires instructions (the standing method for this new worker type).",
      path: ["instructions"],
    });
  }
}

export const spawnWorkerInputSchema = z.object(spawnWorkerFields).superRefine(refineCustomWorkerKind);

/** Tool surface for spawn_worker — workers always inherit the chatting agent's provider/model. */
export const spawnWorkerToolInputSchema = z
  .object({
    label: spawnWorkerFields.label,
    role: spawnWorkerFields.role,
    personality: spawnWorkerFields.personality,
    jobDescription: spawnWorkerFields.jobDescription,
    task: spawnWorkerFields.task,
    kind: spawnWorkerFields.kind,
    instructions: spawnWorkerFields.instructions,
    maxSteps: spawnWorkerFields.maxSteps,
  })
  .superRefine(refineCustomWorkerKind);

export type SpawnWorkerInput = z.infer<typeof spawnWorkerInputSchema>;
export type SpawnWorkerToolInput = z.infer<typeof spawnWorkerToolInputSchema>;

export const routineCreateInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  instructions: z.string().trim().min(1).max(20_000),
  cron: z.string().trim().min(1).max(100),
  timezone: z.string().trim().min(1).max(100).optional().default("UTC"),
  paused: z.boolean().optional().default(false),
});

export type RoutineCreateInput = z.infer<typeof routineCreateInputSchema>;

export const routineUpdateInputSchema = z.object({
  routineId: z.string().uuid(),
  title: z.string().trim().min(1).max(120).optional(),
  instructions: z.string().trim().min(1).max(20_000).optional(),
  cron: z.string().trim().min(1).max(100).optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  paused: z.boolean().optional(),
});

export type RoutineUpdateInput = z.infer<typeof routineUpdateInputSchema>;

export const routineIdSchema = z.object({
  routineId: z.string().uuid(),
  ...autoReviewRetryFields,
});

export type RoutineId = z.infer<typeof routineIdSchema>;

/**
 * Batch delete: either all of the caller's routines, or an explicit id list.
 * Why: one Auto-review card for "clear my schedules", not N single deletes.
 */
export const deleteRoutinesInputSchema = z
  .object({
    all: z.boolean().optional(),
    routineIds: z.array(z.string().uuid()).min(1).max(100).optional(),
    ...autoReviewRetryFields,
  })
  .superRefine((value, context) => {
    if (value.all === true) return;
    if (value.routineIds && value.routineIds.length > 0) return;
    context.addIssue({
      code: "custom",
      message: 'Pass all:true to clear every routine, or routineIds:[...] for a specific set.',
    });
  });

export type DeleteRoutinesInput = z.infer<typeof deleteRoutinesInputSchema>;

export const workerRefSchema = workerRefInputSchema;

export type WorkerRef = z.infer<typeof workerRefSchema>;

export const todoStatusSchema = z.enum(["pending", "in_progress", "completed"]);

export const todoItemSchema = z.object({
  content: z.string().trim().min(1).max(500),
  status: todoStatusSchema,
});

export type TodoItem = z.infer<typeof todoItemSchema>;

export const todoWriteInputSchema = z.object({
  todos: z.array(todoItemSchema).max(50),
});

export type TodoWriteInput = z.infer<typeof todoWriteInputSchema>;

export const pathInputSchema = z.object({
  path: z.string().min(1),
});

export const readWriteInputSchema = z.object({
  path: z.string().min(1),
  body: z.string(),
});

export const bashInputSchema = z.object({
  command: z.string().min(1),
  ...autoReviewRetryFields,
});

export const xyInputSchema = z.object({
  x: z.number(),
  y: z.number(),
});

export const typeTextInputSchema = z.object({
  text: z.string().min(1).max(4000),
});

export const keyInputSchema = z.object({
  key: z.string().min(1),
});

export const urlInputSchema = z.object({
  url: z.string().min(1),
});

export const webSearchInputSchema = z.object({
  query: z.string().min(1),
  numResults: z.number().int().min(1).max(20).optional(),
});

export const globInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
});

export const grepInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  include: z.string().optional(),
});

export const browserNavigateInputSchema = z.object({
  url: z.string().min(1),
});

export const browserUidInputSchema = z.object({
  uid: z.string().min(1).max(40),
});

export const browserFillInputSchema = z.object({
  uid: z.string().min(1).max(40),
  value: z.string().max(4000),
});

export const browserPressKeyInputSchema = z.object({
  key: z.string().min(1).max(40),
});

export const browserDialogInputSchema = z.object({
  accept: z.boolean(),
  promptText: z.string().max(500).optional(),
});

export const browserWaitInputSchema = z.object({
  text: z.string().min(1).max(200),
});
