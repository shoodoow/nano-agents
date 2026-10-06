/** Heartbeat interval while a run holds the model. DB: updates `runs` heartbeat. */
export const HEARTBEAT_MS = 30_000;

/** Parent → child → grandchild delegation cap. */
export const MAX_DELEGATION_DEPTH = 2;

export const DELEGATION_HISTORY_SLICE = 10;

/** Parent quick peek at one public URL or search (output also capped by fetch chars). */
export const DISPATCHER_TOOL_BUDGET_WEB_MS = 20_000;

/** Parent read/glob/grep on known paths. */
export const DISPATCHER_TOOL_BUDGET_LOCAL_MS = 8_000;

/** Other dispatcher tools (DB, MCP, install_skill, …). */
export const DISPATCHER_TOOL_BUDGET_DEFAULT_MS = 15_000;

export const MAX_MODEL_STEPS_DISPATCHER = 12;

/** Dispatcher output cap. A narration loop otherwise runs to the provider limit. */
export const DISPATCHER_MAX_OUTPUT_TOKENS = 2_048;

export const MAX_VISION_IMAGES = 3;
export const MAX_VISION_CHARS = 1_000_000;

/**
 * Context window policy (keeps the agent sharp over a years-long thread).
 * RECENT_WINDOW: newest messages kept verbatim in the prompt + model messages.
 * FOLD_BATCH: minimum aged-out messages before a fold runs (avoids tiny folds).
 * SUMMARY_WINDOW: most-recent folded summary items injected every turn; older
 * ones are reached by semantic recall, not dumped into every tail.
 * RECALL_K: top semantically-relevant durable items pulled back per turn.
 */
export const RECENT_WINDOW = 24;
export const FOLD_BATCH = 20;
export const SUMMARY_WINDOW = 24;
export const RECALL_K = 8;

/**
 * Per-message cap for recent model messages (years-long threads stay sharp
 * and bounded). Full bodies stay in the DB and read_history; only the
 * prompt copy is shortened, with an ellipsis marker.
 */
export const TAIL_MESSAGE_CHARS = 600;
