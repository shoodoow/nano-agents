/**
 * Canonical tool catalog (prompt prefix + AI SDK descriptions).
 * Why: single sorted list keeps provider prompt cache stable. DB: none.
 */
import type { AgentMode } from "../types.js";

export type CatalogEntry = { name: string; description: string; modes: AgentMode[] };

const WORKER_TASK_HINT =
  "Task must include Goal, Inputs (URLs/paths), Method, Success check, and Return format for the parent.";

export const toolCatalog: CatalogEntry[] = [
  {
    name: "add_to_group",
    description: "Add an existing account agent to this group room. Use when the team grows after creation. Never works on a private 1:1.",
    modes: ["dispatcher"],
  },
  {
    name: "check_worker",
    description: "Read a worker by the process id spawn_worker returned. running: keep chatting. done: summarize its result. failed: explain and retry or stop_worker.",
    modes: ["dispatcher"],
  },
  {
    name: "create_group",
    description: "Open a new group room you own. Use when teamwork must be visible. Never use this to add someone to a private 1:1 chat.",
    modes: ["dispatcher"],
  },
  {
    name: "create_routine",
    description: "Schedule your own recurring job in this room. Daily is M H * * *, weekly is M H * * D, in an IANA timezone. Does not run the task now.",
    modes: ["dispatcher"],
  },
  {
    name: "delegate",
    description: "Hand a task to a teammate already in this room and wait for their reply (≤2s). For longer work use spawn_worker.",
    modes: ["dispatcher"],
  },
  {
    name: "delete_routine",
    description: "Delete one of your own routines and its pending runs. Call list_routines first if you do not have the id. Cannot delete anyone else's.",
    modes: ["dispatcher"],
  },
  {
    name: "hire_subagent",
    description: "Create a lasting specialist with role, personality, and job (max 10, depth 2). For one task, use spawn_worker. Refuses private 1:1 chats.",
    modes: ["dispatcher"],
  },
  {
    name: "list_routines",
    description: "List your own routines with ids, schedules, pause state, and next run. Use before update_routine or delete_routine.",
    modes: ["dispatcher"],
  },
  {
    name: "list_team",
    description: "List your team agents (id, name, label, role). Use before delegate so you pick someone already in the room.",
    modes: ["dispatcher"],
  },
  {
    name: "notify_user",
    description: "Ping the person when you are blocked on them or something is urgent. Not for routine progress. Open room shows a banner; closed room may push.",
    modes: ["dispatcher"],
  },
  {
    name: "react_to_message",
    description: "One emoji tapback when a reaction is the whole reply. Use instead of send_message only for a bare acknowledgement. Rare.",
    modes: ["dispatcher"],
  },
  {
    name: "read_history",
    description: "Read one cited message by id, or search a short slice (max 5). Use when a fact points at a message. Does not dump the transcript.",
    modes: ["dispatcher", "worker"],
  },
  {
    name: "read_skill",
    description: "Load one skill's full instructions by name. Use only when this turn needs that procedure. The catalog in the prompt is names only.",
    modes: ["dispatcher", "worker"],
  },
  {
    name: "send_message",
    description:
      "The only text the person sees. Call this first on every user turn: a direct answer, or a one-line ack that you started the work. Never include a process id. Plain assistant text is invisible.",
    modes: ["dispatcher"],
  },
  {
    name: "spawn_worker",
    description: `Required for any search, page, file, command, or desktop task. Returns immediately. ${WORKER_TASK_HINT}`,
    modes: ["dispatcher"],
  },
  {
    name: "stop_worker",
    description: "Stop a worker that is wedged, wrong, or no longer needed. Use the process id from spawn_worker. Stopped work reads as failed.",
    modes: ["dispatcher"],
  },
  {
    name: "todo_list",
    description: "Read your worklist. Use after a restart, a routine wake, or when picking up a worker's job so you know what is still open.",
    modes: ["dispatcher"],
  },
  {
    name: "todo_write",
    description: "Replace your worklist for this job with pending, in_progress, and completed items. Use on multi-step work so a later turn can resume it.",
    modes: ["dispatcher"],
  },
  {
    name: "update_routine",
    description: "Change your own routine: instructions, schedule, timezone, or paused. Use list_routines for the id. Pausing stops future runs; it does not run the job now.",
    modes: ["dispatcher"],
  },
];

export function listToolNames(mode: AgentMode, pluginTools: { name: string; modes?: AgentMode[] }[] = []): string[] {
  const names = [
    ...toolCatalog.filter((entry) => entry.modes.includes(mode)).map((entry) => entry.name),
    ...pluginTools.filter((entry) => !entry.modes || entry.modes.includes(mode)).map((entry) => entry.name),
  ];
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

export function listToolOffers(mode: AgentMode): { name: string; description: string }[] {
  return toolCatalog
    .filter((entry) => entry.modes.includes(mode))
    .map(({ name, description }) => ({ name, description }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Soft validation before spawn: returns hint for model to fix task. */
export function validateWorkerTask(task: string): { ok: true } | { ok: false; hint: string } {
  const trimmed = task.trim();
  if (trimmed.length < 40) {
    return { ok: false, hint: "Task is too short. Include Goal, Inputs, Method, Success check, and Return format." };
  }
  return { ok: true };
}
