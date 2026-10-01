# Database persistence map

User-visible path (every bubble):

1. `messages` / `reactions` / `notifications` row committed (short tx)
2. `events` row via `TurnEmitter` → `appendEvent`
3. Live SSE via `publish` / `onEvent`

Turn slot:

- `runs` — claim at start, heartbeat while model runs, `done` / `failed` at end

Worker path:

1. `spawn_worker` → `agents` (hidden child) + `delegations` (`running`)
2. `runWorker` → `delegations.result` + `status` (always non-empty report)
3. `TurnBus` `worker.settled` → `deliverWorkerResult` or parent cue turn
4. User sees parent `messages` row when delivered

Delegate (sync ≤2s):

- `delegations` + child `messages` with `viaAgentId`

Queue:

- User `messages.queued` while room busy; `continueQueuedTurn` drains after run ends
