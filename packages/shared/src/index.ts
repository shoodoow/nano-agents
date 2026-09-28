import { z } from "zod";

export const accountSchema = z.object({
  name: z.string().min(1),
});

export const agentCreateSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  provider: z.string().min(1),
  modelId: z.string().min(1),
});

export const agentFlagsSchema = z.object({
  notify: z.boolean(),
  pinned: z.boolean(),
  hidden: z.boolean(),
});

export type Account = z.infer<typeof accountSchema>;
export type AgentCreate = z.infer<typeof agentCreateSchema>;
export type AgentFlags = z.infer<typeof agentFlagsSchema>;
