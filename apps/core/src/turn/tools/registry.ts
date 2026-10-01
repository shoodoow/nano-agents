/**
 * AI SDK tool map for dispatcher/delegate turns: tool({ description, inputSchema, execute }).
 * The harness passes the result as generateText({ tools }) — the provider receives
 * definitions from the SDK; nothing is duplicated in the text prompt.
 */
import { jsonSchema, tool, type Schema, type ToolSet } from "ai";
import { randomUUID } from "node:crypto";
import type { AgentMode } from "../types.js";
import { DISPATCHER_TOOL_BUDGET_MS } from "../constants.js";
import { tracePreview } from "../trace/sinks/jsonl.js";
import type { ToolContext } from "./context.js";
import { dispatcherExecutors, executeDelegate } from "./executors.js";
import { appendMcpTools } from "../../mcp/tools.js";
import { listPluginToolsForMode } from "../plugins/registry.js";
import { sendMessageToolJsonSchema } from "./send-message-tool-schema.js";

const WORKER_TASK_HINT =
  "Task must include Goal, Inputs (URLs/paths), Method, Success check, and Return format for the parent.";

type BuiltInTool = {
  name: string;
  description: string;
  modes: AgentMode[];
  inputSchema: Schema<unknown>;
};

/** Sorted built-in dispatcher tool names (SDK registration only). */
export function dispatcherToolNames(): string[] {
  return builtInTools.filter((t) => t.modes.includes("dispatcher")).map((t) => t.name).sort((a, b) => a.localeCompare(b));
}

const builtInTools: BuiltInTool[] = [
  {
    name: "add_to_group",
    description: "Add an existing account agent to this group room. Use when the team grows after creation. Never works on a private 1:1.",
    modes: ["dispatcher"],
    inputSchema: jsonSchema<{ agentId: string }>({
      type: "object",
      properties: { agentId: { type: "string" } },
      required: ["agentId"],
    }),
  },
  {
    name: "check_worker",
    description: "Read a worker by the process id spawn_worker returned. running: keep chatting. done: summarize its result. failed: explain and retry or stop_worker.",
    modes: ["dispatcher"],
    inputSchema: jsonSchema<{ workerId: string }>({
      type: "object",
      properties: { workerId: { type: "string" } },
      required: ["workerId"],
    }),
  },
  {
    name: "create_group",
    description: "Open a new group room you own. Use when teamwork must be visible. Never use this to add someone to a private 1:1 chat.",
    modes: ["dispatcher"],
    inputSchema: jsonSchema<{ title: string; memberIds: string[] }>({
      type: "object",
      properties: { title: { type: "string" }, memberIds: { type: "array", items: { type: "string" } } },
      required: ["title", "memberIds"],
    }),
  },
  {
    name: "create_routine",
    description: "Schedule your own recurring job in this room. Daily is M H * * *, weekly is M H * * D, in an IANA timezone. Does not run the task now.",
    modes: ["dispatcher"],
    inputSchema: jsonSchema<{ body: string; cron: string; timezone?: string }>({
      type: "object",
      properties: { body: { type: "string" }, cron: { type: "string" }, timezone: { type: "string" } },
      required: ["body", "cron"],
    }),
  },
  {
    name: "delegate",
    description: "Hand a task to a teammate already in this room and wait for their reply (≤2s). For longer work use spawn_worker.",
    modes: ["dispatcher"],
    inputSchema: jsonSchema<{ agentId: string; task: string }>({
      type: "object",
      properties: { agentId: { type: "string" }, task: { type: "string" } },
      required: ["agentId", "task"],
    }),
  },
  {
    name: "delete_routine",
    description: "Delete one of your own routines and its pending runs. Call list_routines first if you do not have the id. Cannot delete anyone else's.",
    modes: ["dispatcher"],
    inputSchema: jsonSchema<{ routineId: string }>({
      type: "object",
      properties: { routineId: { type: "string" } },
      required: ["routineId"],
    }),
  },
  {
    name: "hire_subagent",
    description: "Create a lasting teammate with role, personality, and job (max 10 visible teammates; hidden workers do not count). For one task, use spawn_worker. Refuses private 1:1 chats.",
    modes: ["dispatcher"],
    inputSchema: jsonSchema({
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
  },
  {
    name: "list_routines",
    description: "List your own routines with ids, schedules, pause state, and next run. Use before update_routine or delete_routine.",
    modes: ["dispatcher"],
    inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
  },
  {
    name: "list_team",
    description: "List your team agents (id, name, label, role). Use before delegate so you pick someone already in the room.",
    modes: ["dispatcher"],
    inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
  },
  {
    name: "notify_user",
    description: "Ping the person when you are blocked on them or something is urgent. Not for routine progress. Open room shows a banner; closed room may push.",
    modes: ["dispatcher"],
    inputSchema: jsonSchema<{ title: string; body: string; urgency?: string }>({
      type: "object",
      properties: { title: { type: "string" }, body: { type: "string" }, urgency: { type: "string" } },
      required: ["title", "body"],
    }),
  },
  {
    name: "react_to_message",
    description: "One emoji tapback when a reaction is the whole reply. Use instead of send_message only for a bare acknowledgement. Rare.",
    modes: ["dispatcher"],
    inputSchema: jsonSchema<{ messageId: string; emoji: string }>({
      type: "object",
      properties: { messageId: { type: "string" }, emoji: { type: "string" } },
      required: ["messageId", "emoji"],
    }),
  },
  {
    name: "read_history",
    description: "Read one cited message by id, or search a short slice (max 5). Use when a fact points at a message. Does not dump the transcript.",
    modes: ["dispatcher", "worker"],
    inputSchema: jsonSchema<{ messageId?: string; search?: string }>({
      type: "object",
      properties: { messageId: { type: "string" }, search: { type: "string" } },
    }),
  },
  {
    name: "read_skill",
    description: "Load one skill's full instructions by name. Use only when this turn needs that procedure.",
    modes: ["dispatcher", "worker"],
    inputSchema: jsonSchema<{ name: string }>({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    }),
  },
  {
    name: "send_message",
    description:
      'The only text the person sees. Call this first on every user turn. Format: blocks: [{ "kind": "text", "markdown": "..." }] — kind and markdown are required on every text block; do not use bare strings or keys like text/type without kind. Never include a process id. Plain assistant text is invisible.',
    modes: ["dispatcher"],
    inputSchema: jsonSchema(sendMessageToolJsonSchema as never),
  },
  {
    name: "spawn_worker",
    description: `Required for any search, page, file, command, or desktop task. Returns immediately. Finished workers become free and are reused on the next spawn (max ${10} concurrent hidden worker rows). If the tool returns error with workers, use check_worker or stop_worker on those ids. ${WORKER_TASK_HINT}`,
    modes: ["dispatcher"],
    inputSchema: jsonSchema({
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
  },
  {
    name: "stop_worker",
    description:
      "Stop a worker that is wedged, wrong, or no longer needed. Use the process id from spawn_worker. Stopped work reads as failed and frees that hidden worker for reuse.",
    modes: ["dispatcher"],
    inputSchema: jsonSchema<{ workerId: string }>({
      type: "object",
      properties: { workerId: { type: "string" } },
      required: ["workerId"],
    }),
  },
  {
    name: "todo_list",
    description: "Read your worklist. Use after a restart, a routine wake, or when picking up a worker's job so you know what is still open.",
    modes: ["dispatcher"],
    inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
  },
  {
    name: "todo_write",
    description: "Replace your worklist for this job with pending, in_progress, and completed items. Use on multi-step work so a later turn can resume it.",
    modes: ["dispatcher"],
    inputSchema: jsonSchema<{ todos: { content: string; status: string }[] }>({
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: { content: { type: "string" }, status: { type: "string" } },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    }),
  },
  {
    name: "update_routine",
    description: "Change your own routine: instructions, schedule, timezone, or paused. Use list_routines for the id. Pausing stops future runs; it does not run the job now.",
    modes: ["dispatcher"],
    inputSchema: jsonSchema({
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
  },
];

export function wrapToolExecute(ctx: ToolContext, mode: AgentMode, name: string, execute: (input: Record<string, unknown>) => Promise<unknown>) {
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
  const set: Record<string, unknown> = {};
  for (const def of builtInTools) {
    if (!def.modes.includes(mode)) continue;
    if (def.name === "spawn_worker" && mode !== "dispatcher") continue;
    if (!dispatcherExecutors[def.name] && def.name !== "delegate") continue;
    set[def.name] = tool({
      description: def.description,
      inputSchema: def.inputSchema as never,
      execute: wrapToolExecute(ctx, mode, def.name, executorFor(def.name, ctx)) as never,
    });
  }
  for (const plugin of listPluginToolsForMode(mode)) {
    set[plugin.fullName] = tool({
      description: plugin.description,
      inputSchema: plugin.inputSchema as never,
      execute: wrapToolExecute(ctx, mode, plugin.fullName, (input) => plugin.execute(ctx, input)) as never,
    });
  }
  return set as ToolSet;
}

export async function buildFullToolSet(mode: AgentMode, ctx: ToolContext): Promise<ToolSet> {
  const set = buildToolSet(mode, ctx) as Record<string, unknown>;
  await appendMcpTools(ctx, set, (name, execute) => wrapToolExecute(ctx, mode, name, execute));
  return set as ToolSet;
}
