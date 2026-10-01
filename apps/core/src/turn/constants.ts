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
