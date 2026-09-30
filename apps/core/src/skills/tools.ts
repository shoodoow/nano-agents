export type ToolOffer = { name: string; description: string };

// Why: the tool catalog is part of the cache-stable prompt prefix (see
// memory/context.ts). Every tool the model can call must appear here sorted,
// otherwise the prefix bytes drift per turn and prompt caching misses.
// send_message/react/notify_user are the agent voice; read_history/read_skill
// are recall; hire_subagent/delegate/list_team are the teams protocol;
// computer_* are the grounded desktop hands (screenshot/mouse/click/type/key
// on the assigned 1280x800 display — the same :N the viewer proxies).
const defaults: ToolOffer[] = [
  { name: "add_to_group", description: "Add an existing account agent to this group room. Use when the team grows after creation. Never works on a private 1:1." },
  { name: "bash", description: "Run one shell command on your Linux computer. If you are the agent in the chat, hand real work to spawn_worker instead. Use bash only for one quick command, or when you are the worker doing the task." },
  { name: "check_worker", description: "Read a worker by the process id spawn_worker returned. running: keep chatting. done: summarize its result. failed: explain and retry or stop_worker." },
  { name: "computer_click", description: "Move and left-click at x/y on the 1280x800 desktop. Screenshot first. Workers use this; the chatting agent should spawn_worker for desktop work." },
  { name: "computer_key", description: "Press one key combo (Return, Escape, Tab, arrows, or ctrl/alt/shift+x) on your desktop. Use after a click has focused the right place." },
  { name: "computer_mouse", description: "Move the pointer to x/y on your desktop without clicking. Prefer computer_click when you mean to click." },
  { name: "computer_screenshot", description: "PNG of your 1280x800 desktop. Call this before any click or type so coordinates match what is on screen." },
  { name: "computer_type", description: "Type text into the focused desktop field. Click the field first. For a whole desktop task, spawn_worker instead of driving it yourself." },
  { name: "create_group", description: "Open a new group room you own. Use when teamwork must be visible. Never use this to add someone to a private 1:1 chat." },
  { name: "create_routine", description: "Schedule your own recurring job in this room. Daily is M H * * *, weekly is M H * * D, in an IANA timezone. Does not run the task now." },
  { name: "delegate", description: "Hand a task to a teammate already in this room and wait for their reply. Use only for a visible handoff. To stay available, use spawn_worker." },
  { name: "delete_routine", description: "Delete one of your own routines and its pending runs. Call list_routines first if you do not have the id. Cannot delete anyone else's." },
  { name: "glob", description: "List files by name pattern under your home or /shared, up to 100 paths. Use to find files before reading them. A big search belongs on a worker." },
  { name: "grep", description: "Search file contents for a pattern under your home or /shared, up to 100 hits. Use when you know the text but not the file. A broad hunt belongs on a worker." },
  { name: "hire_subagent", description: "Create a lasting specialist with role, personality, and job (max 10, depth 2). Use when you need a named teammate. For one task, use spawn_worker. Refuses private 1:1 chats." },
  { name: "list_routines", description: "List your own routines with ids, schedules, pause state, and next run. Use before update_routine or delete_routine." },
  { name: "list_team", description: "List your team agents (id, name, label, role). Use before delegate so you pick someone already in the room." },
  { name: "notify_user", description: "Ping the person when you are blocked on them or something is urgent. Not for routine progress. Open room shows a banner; closed room may push." },
  { name: "react_to_message", description: "One emoji tapback when a reaction is the whole reply. Use instead of send_message only for a bare acknowledgement. Rare." },
  { name: "read", description: "Read one file in your home or /shared. Use for a single known path. Reading around a project belongs on a worker via spawn_worker." },
  { name: "read_history", description: "Read one cited message by id, or search a short slice (max 5). Use when a fact points at a message. Does not dump the transcript." },
  { name: "read_skill", description: "Load one skill's full instructions by name. Use only when this turn needs that procedure. The catalog in the prompt is names only." },
  { name: "send_message", description: "The only text the person sees. Use first on every user turn, again to share a process id, and again to deliver a result. Plain assistant text is invisible." },
  { name: "spawn_worker", description: "Default for any real task. Starts a hidden worker and returns a process id immediately so you stay in the chat. Tell the person the id, then check_worker later and summarize its result." },
  { name: "stop_worker", description: "Stop a worker that is wedged, wrong, or no longer needed. Use the process id from spawn_worker. Stopped work reads as failed." },
  { name: "todo_list", description: "Read your worklist. Use after a restart, a routine wake, or when picking up a worker's job so you know what is still open." },
  { name: "todo_write", description: "Replace your worklist for this job with pending, in_progress, and completed items. Use on multi-step work so a later turn can resume it." },
  { name: "update_routine", description: "Change your own routine: instructions, schedule, timezone, or paused. Use list_routines for the id. Pausing stops future runs; it does not run the job now." },
  { name: "web_fetch", description: "Read one public page as text. When the person names a site, fetch it first before searching. Never ask for details while a fetch is untried." },
  { name: "web_search", description: "Search the public web for titles, URLs, and snippets. Quick lookups run inline. One empty result never ends the task: retry, fetch, or spawn_worker." },
  { name: "write", description: "Write one file in your home or /shared. Use for a single file you already know. Building or editing a project belongs on a worker via spawn_worker." },
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
