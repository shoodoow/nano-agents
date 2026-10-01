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
  agentId: z.string().uuid(),
});

/** @deprecated import name — same as memberAddInputSchema */
export const memberAddSchema = memberAddInputSchema;

export const workerRefInputSchema = z.object({
  workerId: z.string().uuid(),
});

export const groupCreateInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  memberIds: z.array(z.string().uuid()).max(19).optional().default([]),
});

export type GroupCreateInput = z.infer<typeof groupCreateInputSchema>;

export const groupConversationInputSchema = z.object({
  conversationId: z.string().uuid(),
});

export type GroupConversationInput = z.infer<typeof groupConversationInputSchema>;

export const subagentCreateSchema = z.object({
  label: z.string().trim().min(1).max(100),
  role: z.string().trim().min(1).max(100),
  personality: z.string().trim().max(500).optional().default(""),
  jobDescription: z.string().trim().min(1).max(10_000),
  provider: z.enum(providerNames).optional(),
  modelId: z.string().trim().min(1).max(200).optional(),
  /** Required when hiring from a private 1:1 — use conversationId from create_group. */
  conversationId: z.string().uuid().optional(),
});

export type SubagentCreate = z.infer<typeof subagentCreateSchema>;

export const delegateSchema = z.object({
  agentId: z.string().uuid(),
  task: z.string().trim().min(1).max(20_000),
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

export const readSkillToolInputSchema = z.object({
  name: z.string().min(1),
});

export const spawnWorkerInputSchema = z.object({
  label: z.string().trim().min(1).max(100),
  role: z.string().trim().min(1).max(100),
  personality: z.string().trim().max(500).optional().default(""),
  jobDescription: z.string().trim().min(1).max(10_000),
  task: z.string().trim().min(1).max(20_000),
  provider: z.enum(providerNames).optional(),
  modelId: z.string().trim().min(1).max(200).optional(),
});

/** Tool surface for spawn_worker — workers always inherit the chatting agent's provider/model. */
export const spawnWorkerToolInputSchema = spawnWorkerInputSchema.omit({ provider: true, modelId: true });

export type SpawnWorkerInput = z.infer<typeof spawnWorkerInputSchema>;
export type SpawnWorkerToolInput = z.infer<typeof spawnWorkerToolInputSchema>;

export const routineCreateInputSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
  cron: z.string().trim().min(1).max(100),
  timezone: z.string().trim().min(1).max(100).optional().default("UTC"),
  paused: z.boolean().optional().default(false),
});

export type RoutineCreateInput = z.infer<typeof routineCreateInputSchema>;

export const routineUpdateInputSchema = z.object({
  routineId: z.string().uuid(),
  body: z.string().trim().min(1).max(20_000).optional(),
  cron: z.string().trim().min(1).max(100).optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  paused: z.boolean().optional(),
});

export type RoutineUpdateInput = z.infer<typeof routineUpdateInputSchema>;

export const routineIdSchema = z.object({
  routineId: z.string().uuid(),
});

export type RoutineId = z.infer<typeof routineIdSchema>;

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
