import type { z } from "zod";
import {
  bashInputSchema,
  delegateSchema,
  emptyToolInputSchema,
  globInputSchema,
  grepInputSchema,
  groupConversationInputSchema,
  groupCreateInputSchema,
  keyInputSchema,
  memberAddInputSchema,
  notifyInputSchema,
  reactionSchema,
  readHistoryToolInputSchema,
  readSkillToolInputSchema,
  routineCreateInputSchema,
  routineIdSchema,
  routineUpdateInputSchema,
  sendMessageInputSchema,
  spawnWorkerToolInputSchema,
  subagentCreateSchema,
  todoWriteInputSchema,
  typeTextInputSchema,
  urlInputSchema,
  webSearchInputSchema,
  workerRefInputSchema,
  xyInputSchema,
  pathInputSchema,
  readWriteInputSchema,
} from "./schemas.js";

const WORKER_TASK_HINT =
  "Act like the task owner, not a messenger: the worker starts blank, so the task must fully assign the job. Task must include Goal (one sentence, with done-criteria), Inputs (exact URLs/paths/quotes), Method, Success check (how you will verify the result answers the Goal), and Return format with proof. Never pass provider or modelId — the worker uses your model. Proof is mandatory: demand exact numbers, URLs, and quotes observed on screen — never estimates, never invented content. Return format is always three labeled sections: Findings: (evidence), What I did: (steps), Blockers: (what stopped you, or none). Desktop/browser: put the exact URL in the task; explore cheapest-first — web_fetch, then headless DevTools dump-dom for JS pages, visible Chromium only for login-gated pages. Never mention screenshots in the brief — the worker's own manual covers when the camera is allowed, and unmentioned screenshots stay off. Only write screenshots into the task when the person explicitly asked for visual verification. Reuse the existing Chromium window (do not pkill chromium); drive clicks with computer_click, computer_type, and computer_key, never xdotool or Playwright from bash; no OCR unless the person asked. If the screen needs a password, 2FA, captcha, or payment, the worker ends with NEEDS_PERSON: plus one instruction for the person."

export type ToolSurface = "dispatcher" | "worker";

export type ToolDefinition = {
  name: string;
  description: string;
  surfaces: ToolSurface[];
  requiresLinux?: boolean;
  inputSchema: z.ZodType;
  descriptionWorker?: string;
};

export const allToolDefinitions: ToolDefinition[] = [
  {
    name: "add_to_group",
    description:
      "Add an existing account agent to this group room. Use when the team grows after creation. Never works on a private 1:1.",
    surfaces: ["dispatcher"],
    inputSchema: memberAddInputSchema,
  },
  {
    name: "create_group",
    description:
      "Open a new group room you own (title only is fine). Add teammates later with hire_subagent or add_to_group using agent UUIDs from list_team — not names. Never use this to change a private 1:1 chat.",
    surfaces: ["dispatcher"],
    inputSchema: groupCreateInputSchema,
  },
  {
    name: "create_routine",
    description:
      "Schedule your own recurring job in this room. Daily is M H * * *, weekly is M H * * D, in an IANA timezone. Does not run the task now.",
    surfaces: ["dispatcher"],
    inputSchema: routineCreateInputSchema,
  },
  {
    name: "delegate",
    description: "Hand a task to a teammate already in this room and wait for their reply (≤2s). For longer work use spawn_worker.",
    surfaces: ["dispatcher"],
    inputSchema: delegateSchema,
  },
  {
    name: "delete_group",
    description:
      "Delete a group room you own. Use list_groups for ids. Cannot delete private 1:1 chats or the room you are chatting in right now. Teammates stay on the account; only the group and its chat history are removed. Irreversible: ask the person first, then re-call with confirmed:true.",
    surfaces: ["dispatcher"],
    inputSchema: groupConversationInputSchema,
  },
  {
    name: "delete_routine",
    description:
      "Delete one of your own routines and its pending runs. Call list_routines first if you do not have the id. Cannot delete anyone else's.",
    surfaces: ["dispatcher"],
    inputSchema: routineIdSchema,
  },
  {
    name: "hire_subagent",
    description:
      "Create a lasting teammate with role, personality, and job (max 10 visible teammates; hidden workers do not count). For one task, use spawn_worker. In a private 1:1 chat: call create_group first, then hire_subagent again with conversationId set to the group id create_group returned. In a group room, omit conversationId.",
    surfaces: ["dispatcher"],
    inputSchema: subagentCreateSchema,
  },
  {
    name: "list_groups",
    description:
      "List group rooms you belong to (id, title, whether you own it). Use before delete_group or when you need a conversationId for hire_subagent from a private chat.",
    surfaces: ["dispatcher"],
    inputSchema: emptyToolInputSchema,
  },
  {
    name: "list_routines",
    description: "List your own routines with ids, schedules, pause state, and next run. Use before update_routine or delete_routine.",
    surfaces: ["dispatcher"],
    inputSchema: emptyToolInputSchema,
  },
  {
    name: "list_team",
    description: "List your team agents (id, name, label, role). Use before delegate so you pick someone already in the room.",
    surfaces: ["dispatcher"],
    inputSchema: emptyToolInputSchema,
  },
  {
    name: "notify_user",
    description:
      "Ping the person when you are blocked on them or something is urgent. Not for routine progress. Open room shows a banner; closed room may push.",
    surfaces: ["dispatcher"],
    inputSchema: notifyInputSchema,
  },
  {
    name: "react_to_message",
    description:
      "One emoji tapback when a reaction is the whole reply. Use instead of send_message only for a bare acknowledgement. Rare.",
    surfaces: ["dispatcher"],
    inputSchema: reactionSchema,
  },
  {
    name: "read_history",
    description:
      "Read one cited message by id, or search a short slice (max 5). Use when a fact points at a message. Does not dump the transcript.",
    surfaces: ["dispatcher", "worker"],
    inputSchema: readHistoryToolInputSchema,
    descriptionWorker:
      "Read one cited message by id, or search a short slice (max 5), when the task depends on something said in the room.",
  },
  {
    name: "read_skill",
    description: "Load one skill's full instructions by name. Use only when this turn needs that procedure.",
    surfaces: ["dispatcher", "worker"],
    inputSchema: readSkillToolInputSchema,
    descriptionWorker: "Load one skill's steps by name when the task needs that procedure. Skip it when the task is already clear.",
  },
  {
    name: "send_message",
    description:
      'The only channel the person sees. Call first on every user turn. blocks: array of typed objects — kind text (markdown, usual acks), image (url), code (code), file (url+name), widget (widget: checklist|chart|approval|agent-card + props). Up to 10 blocks per send; mix types when useful. Never bare strings or root-level kind without a blocks array. Plain assistant text is invisible.',
    surfaces: ["dispatcher"],
    inputSchema: sendMessageInputSchema,
  },
  {
    name: "spawn_worker",
    description: `Required for any search, page, file, command, or desktop task. Returns immediately with a worker id, then end your turn — the finished result is delivered to you automatically, never poll for it. Do not include provider or modelId. Finished workers become free and are reused on the next spawn (max 10 concurrent hidden worker rows). If the tool returns error with workers, use stop_worker on the wedged id to free it. ${WORKER_TASK_HINT}`,
    surfaces: ["dispatcher"],
    inputSchema: spawnWorkerToolInputSchema,
  },
  {
    name: "stop_worker",
    description:
      "Stop a worker that is wedged, wrong, or no longer needed. Use the process id from spawn_worker. Stopped work reads as failed and frees that hidden worker for reuse.",
    surfaces: ["dispatcher"],
    inputSchema: workerRefInputSchema,
  },
  {
    name: "todo_list",
    description:
      "Read your worklist. Use after a restart, a routine wake, or when picking up a worker's job so you know what is still open.",
    surfaces: ["dispatcher"],
    inputSchema: emptyToolInputSchema,
  },
  {
    name: "todo_write",
    description:
      "Replace your worklist for this job with pending, in_progress, and completed items. Use on multi-step work so a later turn can resume it.",
    surfaces: ["dispatcher"],
    inputSchema: todoWriteInputSchema,
  },
  {
    name: "update_routine",
    description:
      "Change your own routine: instructions, schedule, timezone, or paused. Use list_routines for the id. Pausing stops future runs; it does not run the job now.",
    surfaces: ["dispatcher"],
    inputSchema: routineUpdateInputSchema,
  },
  // --- Linux (worker only, when profile exists) ---
  {
    name: "read",
    description: "Read one file in the agent home or shared directory. Use for a single known path.",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: pathInputSchema,
  },
  {
    name: "write",
    description: "Write one file in the agent home or shared directory when you know the path and body.",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: readWriteInputSchema,
  },
  {
    name: "bash",
    description:
      "Run one shell command on your Linux computer. DISPLAY is already your 1280x800 desktop, so chromium and xterm open on the screen the person watches. Never start Xvfb/x11vnc or override DISPLAY.",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: bashInputSchema,
  },
  {
    name: "computer_screenshot",
    description:
      "PNG of your assigned 1280x800 desktop. Call before any click or type so coordinates match the screen.",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: emptyToolInputSchema,
  },
  {
    name: "computer_mouse",
    description: "Move the pointer to x/y (0-1279, 0-799) without clicking. Screenshot first. Prefer computer_click when you mean to click.",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: xyInputSchema,
  },
  {
    name: "computer_click",
    description: "Move and left-click at x/y on your desktop in one step. Screenshot first.",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: xyInputSchema,
  },
  {
    name: "computer_type",
    description: "Type 1-4000 characters into the focused desktop field. Click that field first.",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: typeTextInputSchema,
  },
  {
    name: "computer_key",
    description: "Press one key combo: Return, Escape, Tab, arrows, F-keys, or ctrl/alt/shift+x.",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: keyInputSchema,
  },
  {
    name: "web_fetch",
    description:
      "Read one public page as text when you already have the URL. JS-heavy pages render automatically. Returns title, text, and outlinks.",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: urlInputSchema,
  },
  {
    name: "web_search",
    description:
      "Search the public web. Returns title, URL, and snippet, not page text. Use to pick links, then web_fetch the ones worth reading.",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: webSearchInputSchema,
  },
  {
    name: "glob",
    description: "List files by name pattern (for example **/*.ts) under home or /shared, up to 100 paths.",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: globInputSchema,
  },
  {
    name: "grep",
    description: "Search file contents for a pattern under home or /shared. Returns file:line hits, up to 100.",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: grepInputSchema,
  },
];

export function toolsForSurface(surface: ToolSurface, opts?: { hasLinux?: boolean }): ToolDefinition[] {
  return allToolDefinitions.filter(
    (t) => t.surfaces.includes(surface) && (surface !== "worker" || !t.requiresLinux || opts?.hasLinux),
  );
}

export function dispatcherToolNames(): string[] {
  return toolsForSurface("dispatcher")
    .map((t) => t.name)
    .sort((a, b) => a.localeCompare(b));
}

export function workerToolNames(hasLinux: boolean): string[] {
  return toolsForSurface("worker", { hasLinux }).map((t) => t.name).sort((a, b) => a.localeCompare(b));
}

export function toolDefinitionByName(name: string): ToolDefinition | undefined {
  return allToolDefinitions.find((t) => t.name === name);
}
