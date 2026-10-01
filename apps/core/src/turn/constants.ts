/** Heartbeat interval while a run holds the model. DB: updates `runs` heartbeat. */
export const HEARTBEAT_MS = 30_000;

/** Parent → child → grandchild delegation cap. */
export const MAX_DELEGATION_DEPTH = 2;

export const DELEGATION_HISTORY_SLICE = 10;

/** Dispatcher sync delegate wall clock before forcing spawn_worker. */
export const DELEGATE_SYNC_TIMEOUT_MS = 2_000;

/** Dispatcher tool execute budget (registry middleware). */
export const DISPATCHER_TOOL_BUDGET_MS = 2_000;

export const MAX_MODEL_STEPS_DISPATCHER = 12;

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
export const RECENT_WINDOW = 40;
export const FOLD_BATCH = 20;
export const SUMMARY_WINDOW = 40;
export const RECALL_K = 8;
