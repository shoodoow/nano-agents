export type ToolOffer = { name: string; description: string };

// Why: the tool catalog is part of the cache-stable prompt prefix (see
// memory/context.ts). Every tool the model can call must appear here sorted,
// otherwise the prefix bytes drift per turn and prompt caching misses.
// send_message/react/notify_user are the agent voice; read_history/read_skill
// are recall; hire_subagent/delegate/list_team are the teams protocol.
// File, shell, desktop, and web tools are absent on purpose: the worker
// calls those via profileTools, so this turn can end and the person can talk.
const defaults: ToolOffer[] = [
  { name: "add_to_group", description: "Add an existing account agent to this group room. Use when the team grows after creation. Never works on a private 1:1." },
  { name: "check_worker", description: "Read a worker by the process id spawn_worker returned. running: keep chatting. done: summarize its result. failed: explain and retry or stop_worker." },
  { name: "create_group", description: "Open a new group room you own. Use when teamwork must be visible. Never use this to add someone to a private 1:1 chat." },
  { name: "create_routine", description: "Schedule your own recurring job in this room. Daily is M H * * *, weekly is M H * * D, in an IANA timezone. Does not run the task now." },
  { name: "delegate", description: "Hand a task to a teammate already in this room and wait for their reply. Use only for a visible handoff. To stay available, use spawn_worker." },
  { name: "delete_routine", description: "Delete one of your own routines and its pending runs. Call list_routines first if you do not have the id. Cannot delete anyone else's." },
  { name: "hire_subagent", description: "Create a lasting specialist with role, personality, and job (max 10, depth 2). Use when you need a named teammate. For one task, use spawn_worker. Refuses private 1:1 chats." },
  { name: "list_routines", description: "List your own routines with ids, schedules, pause state, and next run. Use before update_routine or delete_routine." },
  { name: "list_team", description: "List your team agents (id, name, label, role). Use before delegate so you pick someone already in the room." },
  { name: "notify_user", description: "Ping the person when you are blocked on them or something is urgent. Not for routine progress. Open room shows a banner; closed room may push." },
  { name: "react_to_message", description: "One emoji tapback when a reaction is the whole reply. Use instead of send_message only for a bare acknowledgement. Rare." },
  { name: "read_history", description: "Read one cited message by id, or search a short slice (max 5). Use when a fact points at a message. Does not dump the transcript." },
  { name: "read_skill", description: "Load one skill's full instructions by name. Use only when this turn needs that procedure. The catalog in the prompt is names only." },
  { name: "send_message", description: "The only text the person sees. Use first on every user turn, and again to deliver a result. Never include a process id. Plain assistant text is invisible." },
  { name: "spawn_worker", description: "Required for any search, page, file, command, or desktop task, including opening Chrome. A login is not a refusal: open the page, and if a password, 2FA, captcha, or payment blocks it, the worker stops with NEEDS_PERSON. Returns immediately. Tell the person you started, with no process id, then stop." },
  { name: "stop_worker", description: "Stop a worker that is wedged, wrong, or no longer needed. Use the process id from spawn_worker. Stopped work reads as failed." },
  { name: "todo_list", description: "Read your worklist. Use after a restart, a routine wake, or when picking up a worker's job so you know what is still open." },
  { name: "todo_write", description: "Replace your worklist for this job with pending, in_progress, and completed items. Use on multi-step work so a later turn can resume it." },
  { name: "update_routine", description: "Change your own routine: instructions, schedule, timezone, or paused. Use list_routines for the id. Pausing stops future runs; it does not run the job now." },
];

/**
 * Builds the tool list for one turn.
 * Input: the MCP tool lists, each with its server name.
 * Output: the default tools plus each plugin tool prefixed as server_tool, sorted by name.
 */
export function listTools(plugins: { server: string; tools: ToolOffer[] }[]): ToolOffer[] {
  const prefixed = plugins.flatMap((plugin) =>
    plugin.tools.map((tool) => ({
      name: `${plugin.server}_${tool.name}`,
      description: tool.description,
    })),
  );
  return [...defaults, ...prefixed].sort((left, right) => left.name.localeCompare(right.name));
}
