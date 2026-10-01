/**
 * In-process orchestration bus (not SSE).
 * Why: worker settle, mention handoff, and parent wake subscribe here instead of nested callbacks.
 * DB: handlers write existing tables; bus carries pointers only.
 */
import type { WorkerSettled } from "../../rooms/subagents.js";

export type MentionHandoff = {
  type: "mention.handoff";
  fromAgentId: string;
  toAgentId: string;
  excerpt: string;
};

export type ParentWakeRequested = {
  type: "parent.wake";
  accountId: string;
  conversationId: string;
  parentAgentId: string;
  cue: string;
  reason: "worker_failed" | "worker_done_summarize";
  skillsRoot?: string;
};

export type InternalTurnEvent = { type: "worker.settled" } & WorkerSettled & {
    accountId: string;
    conversationId: string;
    parentAgentId: string;
    delegationId: string;
    skillsRoot?: string;
  } | MentionHandoff | ParentWakeRequested;

type Handler = (event: InternalTurnEvent) => void | Promise<void>;

const handlers: Handler[] = [];

export function subscribeTurnBus(handler: Handler): () => void {
  handlers.push(handler);
  return () => {
    const index = handlers.indexOf(handler);
    if (index >= 0) handlers.splice(index, 1);
  };
}

export async function emitTurnBus(event: InternalTurnEvent): Promise<void> {
  await Promise.allSettled(handlers.map((handler) => handler(event)));
}
