import { agentCreateSchema } from "@nano-agents/shared";

export const acceptedAgentFields = agentCreateSchema.keyof().options;
