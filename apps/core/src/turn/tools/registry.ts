/**
 * Builds AI SDK tool maps from catalog + executors (trace + dispatcher timing).
 * Why: single registration point for plugins and mode guards. DB: via executors.
 */
import { jsonSchema, tool, type ToolSet } from "ai";
import { randomUUID } from "node:crypto";
import type { AgentMode } from "../types.js";
import { DISPATCHER_TOOL_BUDGET_MS } from "../constants.js";
import { tracePreview } from "../trace/sinks/jsonl.js";
import { toolCatalog } from "./catalog.js";
import type { ToolContext } from "./context.js";
import { dispatcherExecutors, executeDelegate } from "./executors.js";
import { listPluginToolsForMode } from "../plugins/registry.js";

function wrapExecute(ctx: ToolContext, mode: AgentMode, name: string, execute: (input: Record<string, unknown>) => Promise<unknown>) {
  return async (input: Record<string, unknown>) => {
    const toolCallId = randomUUID();
    const started = performance.now();
    await ctx.traceSession?.emit({ type: "tool.call.start", toolCallId, name, input });
    try {
      let result: unknown;
      if (mode === "dispatcher" || mode === "delegate") {
        result = await Promise.race([
          execute(input),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("Tool exceeded 2s — use spawn_worker for long work.")),
              DISPATCHER_TOOL_BUDGET_MS,
            ),
          ),
        ]);
      } else {
        result = await execute(input);
      }
      const durationMs = Math.round(performance.now() - started);
      await ctx.traceSession?.emit({
        type: "tool.call.finish",
        toolCallId,
        name,
        input,
        outputPreview: tracePreview(result),
        durationMs,
      });
      return result;
    } catch (error) {
      const durationMs = Math.round(performance.now() - started);
      const message = error instanceof Error ? error.message : "Tool failed.";
      await ctx.traceSession?.emit({
        type: "tool.call.finish",
        toolCallId,
        name,
        input,
        outputPreview: tracePreview(message),
        durationMs,
        error: message,
      });
      throw error;
    }
  };
}

const schemas: Record<string, ReturnType<typeof jsonSchema>> = {
  send_message: jsonSchema<{ blocks: unknown; replyTo?: string | null }>({
    type: "object",
    properties: { blocks: { type: "array" }, replyTo: { type: ["string", "null"] } },
    required: ["blocks"],
  }),
  react_to_message: jsonSchema<{ messageId: string; emoji: string }>({
    type: "object",
    properties: { messageId: { type: "string" }, emoji: { type: "string" } },
    required: ["messageId", "emoji"],
  }),
  notify_user: jsonSchema<{ title: string; body: string; urgency?: string }>({
    type: "object",
    properties: { title: { type: "string" }, body: { type: "string" }, urgency: { type: "string" } },
    required: ["title", "body"],
  }),
  read_history: jsonSchema<{ messageId?: string; search?: string }>({
    type: "object",
    properties: { messageId: { type: "string" }, search: { type: "string" } },
  }),
  read_skill: jsonSchema<{ name: string }>({ type: "object", properties: { name: { type: "string" } }, required: ["name"] }),
  hire_subagent: jsonSchema({
    type: "object",
    properties: {
      label: { type: "string" },
      role: { type: "string" },
      personality: { type: "string" },
      jobDescription: { type: "string" },
      provider: { type: "string" },
      modelId: { type: "string" },
    },
    required: ["label", "role", "jobDescription"],
  }),
  delegate: jsonSchema<{ agentId: string; task: string }>({
    type: "object",
    properties: { agentId: { type: "string" }, task: { type: "string" } },
    required: ["agentId", "task"],
  }),
  list_team: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
  add_to_group: jsonSchema<{ agentId: string }>({
    type: "object",
    properties: { agentId: { type: "string" } },
    required: ["agentId"],
  }),
  todo_write: jsonSchema<{ todos: { content: string; status: string }[] }>({
    type: "object",
    properties: { todos: { type: "array" } },
    required: ["todos"],
  }),
  todo_list: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
  create_group: jsonSchema<{ title: string; memberIds: string[] }>({
    type: "object",
    properties: { title: { type: "string" }, memberIds: { type: "array" } },
    required: ["title", "memberIds"],
  }),
  spawn_worker: jsonSchema({
    type: "object",
    properties: {
      label: { type: "string" },
      role: { type: "string" },
      personality: { type: "string" },
      jobDescription: { type: "string" },
      task: { type: "string" },
      provider: { type: "string" },
      modelId: { type: "string" },
    },
    required: ["label", "role", "jobDescription", "task"],
  }),
  check_worker: jsonSchema<{ workerId: string }>({
    type: "object",
    properties: { workerId: { type: "string" } },
    required: ["workerId"],
  }),
  stop_worker: jsonSchema<{ workerId: string }>({
    type: "object",
    properties: { workerId: { type: "string" } },
    required: ["workerId"],
  }),
  create_routine: jsonSchema<{ body: string; cron: string; timezone?: string }>({
    type: "object",
    properties: { body: { type: "string" }, cron: { type: "string" }, timezone: { type: "string" } },
    required: ["body", "cron"],
  }),
  update_routine: jsonSchema({
    type: "object",
    properties: {
      routineId: { type: "string" },
      body: { type: "string" },
      cron: { type: "string" },
      timezone: { type: "string" },
      paused: { type: "boolean" },
    },
    required: ["routineId"],
  }),
  delete_routine: jsonSchema<{ routineId: string }>({
    type: "object",
    properties: { routineId: { type: "string" } },
    required: ["routineId"],
  }),
  list_routines: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
};

function executorFor(name: string, ctx: ToolContext): (input: Record<string, unknown>) => Promise<unknown> {
  if (name === "delegate") {
    return (input) =>
      executeDelegate(ctx, input, (args) =>
        import("../delegation.js").then((module) => module.runDelegatedTurn(ctx.db, args)),
      );
  }
  const fn = dispatcherExecutors[name];
  if (!fn) throw new Error(`Missing executor: ${name}`);
  return (input) => fn(ctx, input);
}

export function buildToolSet(mode: AgentMode, ctx: ToolContext): ToolSet {
  // AI SDK tool generics vary per schema; callers only need a tool map.
  const set: Record<string, unknown> = {};
  for (const entry of toolCatalog) {
    if (!entry.modes.includes(mode)) continue;
    const schema = schemas[entry.name];
    if (!schema) continue;
    if (entry.name === "spawn_worker" && mode !== "dispatcher") continue;
    if (!dispatcherExecutors[entry.name] && entry.name !== "delegate") continue;
    set[entry.name] = tool({
      description: entry.description,
      inputSchema: schema as never,
      execute: wrapExecute(ctx, mode, entry.name, executorFor(entry.name, ctx)) as never,
    });
  }
  for (const plugin of listPluginToolsForMode(mode)) {
    set[plugin.fullName] = tool({
      description: plugin.description,
      inputSchema: plugin.inputSchema as never,
      execute: wrapExecute(ctx, mode, plugin.fullName, (input) => plugin.execute(ctx, input)) as never,
    });
  }
  return set as ToolSet;
}
