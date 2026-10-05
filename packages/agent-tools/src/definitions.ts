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
  rememberFactToolInputSchema,
  correctMemoryToolInputSchema,
  readHistoryToolInputSchema,
  readSkillToolInputSchema,
  deleteRoutinesInputSchema,
  routineCreateInputSchema,
  routineIdSchema,
  routineUpdateInputSchema,
  sendMessageInputSchema,
  spawnWorkerToolInputSchema,
  subagentCreateSchema,
  teammateUpdateSchema,
  todoWriteInputSchema,
  typeTextInputSchema,
  urlInputSchema,
  webSearchInputSchema,
  workerRedirectInputSchema,
  workerRefInputSchema,
  xyInputSchema,
  pathInputSchema,
  readWriteInputSchema,
  installSkillInputSchema,
  browserNavigateInputSchema,
  browserUidInputSchema,
  browserFillInputSchema,
  browserPressKeyInputSchema,
  browserDialogInputSchema,
  browserWaitInputSchema,
} from "./schemas.js";

const WORKER_KIND_HINT =
  "Pick kind by the work: executor (general), computer (desktop GUI — Method must include read_skill computer-use-linux), browser (public web — prefer read_skill chrome-devtools for live pages), explore (files/code search), shell (commands), debug (evidence-based bugs), watch_video / video_review (media), vm_setup (project setup), docs (public documentation). If none fit, kind=custom and pass instructions with the standing method for this new specialist. Default kind is computer.";

const WORKER_TASK_HINT =
  `Act like the task owner, not a messenger: the worker starts blank, so the task must fully assign the job. ${WORKER_KIND_HINT} Task must include Goal (one sentence, with done-criteria), Inputs (exact URLs/paths/quotes), Method, Success check (how you will verify the result answers the Goal), and Return format with proof. Never pass provider or modelId — the worker uses your model. Proof is mandatory: demand exact numbers, URLs, and quotes observed — never estimates, never invented content. Return format is always three labeled sections: Findings: (evidence), What I did: (steps), Blockers: (what stopped you, or none). Skill installs are install_skill on the dispatcher, or kind shell with that tool — never a new teammate. Live pages use browser_snapshot, browser_click, browser_fill, browser_press_key, and browser_handle_dialog (read_skill chrome-devtools). Desktop GUI uses read_skill computer-use-linux. Never mention screenshots unless the person asked for visual proof. Reuse the existing Chromium window (do not pkill chromium). If the screen needs a password, 2FA, or payment, end with NEEDS_PERSON: plus one instruction. A popup ad is not a captcha — dismiss it. If a skill applies, name read_skill <name> in Method. Do not claim a file exists unless you wrote it and checked it.`;

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
      "Schedule your own recurring job in this room. Daily is M H * * *, weekly is M H * * D, in the person's IANA timezone. Does not run now. title is a short phone label; instructions is a standing order to your future self (goal, method, what to send_message, when to stay quiet) — not a fake user chat line. On fire you wake privately and act; the person only sees what you send_message.",
    surfaces: ["dispatcher"],
    inputSchema: routineCreateInputSchema,
  },
  {
    name: "delegate",
    description:
      "Ask a lasting teammate already in this group to act or reply. Their turn starts in the background and their own messages appear visibly in this room. Use agent UUIDs from list_team; text @mentions alone do not wake teammates. For hidden parent-only execution use spawn_worker.",
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
      "Delete one of your own routines and its pending runs. For clearing many or all, use delete_routines (one approval). Call list_routines first if you need the id.",
    surfaces: ["dispatcher"],
    inputSchema: routineIdSchema,
  },
  {
    name: "delete_routines",
    description:
      "Delete many of your routines in one call — prefer this over looping delete_routine. Pass all:true to clear every routine, or routineIds:[...] for a set. One Auto-review approval covers the whole batch.",
    surfaces: ["dispatcher"],
    inputSchema: deleteRoutinesInputSchema,
  },
  {
    name: "hire_subagent",
    description:
      "Create a lasting teammate (max 10 visible teammates; hidden workers do not count). label is a human first name you invent, never the job. role is the job title. Also pass personality and jobDescription. For one task, use spawn_worker. In a private 1:1 chat: call create_group first, then hire_subagent again with conversationId set to the group id create_group returned. In a group room, omit conversationId.",
    surfaces: ["dispatcher"],
    inputSchema: subagentCreateSchema,
  },
  {
    name: "update_teammate",
    description:
      "Change a teammate you hired. agentId comes from list_team. label is their new human first name (one word, never the job). jobDescription replaces their standing instructions. role and personality are optional. Hidden workers cannot be updated.",
    surfaces: ["dispatcher"],
    inputSchema: teammateUpdateSchema,
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
    description:
      "List your own routines with ids, titles, instructions, schedules, pause state, next run, last run, and up to 10 recent finished fires (done/failed). Use before update_routine or delete_routines.",
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
    name: "remember_fact",
    description:
      "Save a durable sourced fact so it survives long chats. scope=agent for your work preferences/behavior/decisions; scope=user for account-wide facts. Cite the message id. Never store secrets, guesses, or temporary status.",
    surfaces: ["dispatcher"],
    inputSchema: rememberFactToolInputSchema,
  },
  {
    name: "correct_memory",
    description:
      "Replace one exact durable fact when the person corrects it. Supply the old text exactly, the replacement, its scope, and the correcting message id.",
    surfaces: ["dispatcher"],
    inputSchema: correctMemoryToolInputSchema,
  },
  {
    name: "read_skill",
    description: "Load one skill's full instructions by name. Use only when this turn needs that procedure.",
    surfaces: ["dispatcher", "worker"],
    inputSchema: readSkillToolInputSchema,
    descriptionWorker: "Load one skill's steps by name when the task needs that procedure. Skip it when the task is already clear.",
  },
  {
    name: "list_skills",
    description:
      "List skills this account can load (name and description). Call this after install_skill or refresh_skills before you tell the person a skill is available.",
    surfaces: ["dispatcher", "worker"],
    inputSchema: emptyToolInputSchema,
  },
  {
    name: "install_skill",
    description:
      "Install one skill into this account's skill folder (not a global home directory). Pass source as owner/repo or owner/repo@skill, or markdown as a full SKILL.md. Then the catalog refreshes for the next turn. Prove it with list_skills or read_skill before saying it is installed.",
    surfaces: ["dispatcher", "worker"],
    inputSchema: installSkillInputSchema,
  },
  {
    name: "refresh_skills",
    description:
      "Rescan the account skill folder and bump prompt versions so the next turn sees newly installed skills without a process restart.",
    surfaces: ["dispatcher", "worker"],
    inputSchema: emptyToolInputSchema,
  },
  {
    name: "send_message",
    description:
      'The only channel the person sees. Call first on every user turn. blocks: array of typed objects — kind text (short markdown: 1–3 sentences, bold the answer, lists only when listing), image (url), code (code), file (url+name), widget. Widgets MUST be real blocks — never markdown like [widget:secret {…}]. Shape: { "kind": "widget", "widget": "question"|"secret"|…, "props": {…} }. question: single decision with prompt + 1–6 short options {label, value?} (skip long descriptions). poll: multi-select only. secret: envName required, never ask in plain text; ends the turn. desktop-handover: message required (what to do on the desktop), optional buttonLabel; use when login/2FA/payment or any step needs the person on your computer — ends the turn. Ask rarely; every question option must be a verified choice. Up to 10 blocks per send. Never bare strings. Plain assistant text is invisible.',
    surfaces: ["dispatcher"],
    inputSchema: sendMessageInputSchema,
  },
  {
    name: "spawn_worker",
    description: `Required for desktop, bash, long research, or anything that would keep this turn busy. Quick web_search / web_fetch / read / glob / grep you call yourself. Returns immediately with a worker id, then end your turn — the finished result is delivered to you automatically, never poll for it. Do not include provider or modelId. Finished workers become free and are reused on the next spawn (max 10 concurrent hidden worker rows). If the tool returns error with workers, use stop_worker on the wedged id to free it. ${WORKER_TASK_HINT}`,
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
    name: "redirect_worker",
    description:
      "Steer a running worker without losing its context: stops its current attempt and restarts the same worker with your new instruction appended to its original brief. Use when it is looping, drifting, or the situation changed (user signed in, new constraint). The instruction must say what to do differently, not ask for status. If the worker already finished, you get its result instead.",
    surfaces: ["dispatcher"],
    inputSchema: workerRedirectInputSchema,
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
  // --- Linux (worker; parent gets read-only cheap tools when a profile exists) ---
  {
    name: "read",
    description: "Read one file in the agent home or shared directory. Use for a single known path.",
    surfaces: ["dispatcher", "worker"],
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
      "PNG of your assigned 1280x800 desktop. Saves to /shared/screenshots/… and returns that path. Call before any click or type so coordinates match the screen. Cite the path in your report — do not send image bytes to the parent.",
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
      "Read one public page as text when you already have the URL. JS-heavy pages render automatically. Returns title, text, and outlinks. On the parent this is capped; spawn_worker for a long page.",
    surfaces: ["dispatcher", "worker"],
    requiresLinux: true,
    inputSchema: urlInputSchema,
  },
  {
    name: "web_search",
    description:
      "Search the public web. Returns title, URL, and snippet, not page text. Use to pick links, then web_fetch the ones worth reading.",
    surfaces: ["dispatcher", "worker"],
    requiresLinux: true,
    inputSchema: webSearchInputSchema,
  },
  {
    name: "glob",
    description: "List files by name pattern (for example **/*.ts) under home or /shared, up to 100 paths.",
    surfaces: ["dispatcher", "worker"],
    requiresLinux: true,
    inputSchema: globInputSchema,
  },
  {
    name: "grep",
    description: "Search file contents for a pattern under home or /shared. Returns file:line hits, up to 100.",
    surfaces: ["dispatcher", "worker"],
    requiresLinux: true,
    inputSchema: grepInputSchema,
  },
  {
    name: "browser_list_pages",
    description: "List open Chrome pages in this account's computer (localhost CDP only). Use before snapshot.",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: emptyToolInputSchema,
  },
  {
    name: "browser_navigate",
    description: "Open an http(s) URL in this account's Chrome. Prefer the deepest URL you already know.",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: browserNavigateInputSchema,
  },
  {
    name: "browser_snapshot",
    description:
      "Text snapshot of the current page with uids for links, buttons, and inputs. Use this before click or fill. Dismiss ad overlays from the snapshot; do not treat a close button as a captcha.",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: emptyToolInputSchema,
  },
  {
    name: "browser_click",
    description: "Click an element by uid from the latest browser_snapshot.",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: browserUidInputSchema,
  },
  {
    name: "browser_fill",
    description: "Type into an input by uid from the latest browser_snapshot. Never type a password, 2FA code, or card.",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: browserFillInputSchema,
  },
  {
    name: "browser_press_key",
    description: "Press a key in the page: Enter, Escape, Tab, PageDown, Home, ArrowDown. Use PageDown to scroll.",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: browserPressKeyInputSchema,
  },
  {
    name: "browser_handle_dialog",
    description: "Accept or dismiss a JavaScript alert, confirm, or prompt. Use this for popup ads that are dialogs.",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: browserDialogInputSchema,
  },
  {
    name: "browser_wait_for",
    description: "Wait until the page text contains a short string, or time out.",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: browserWaitInputSchema,
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
