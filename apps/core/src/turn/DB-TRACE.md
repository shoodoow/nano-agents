# Database persistence map

User-visible path (every bubble):

1. `messages` / `reactions` / `notifications` row committed (short tx)
2. `events` row via `TurnEmitter` → `appendEvent`
3. Live SSE via `publish` / `onEvent`

Turn slot:

- `runs` — claim at start, heartbeat while model runs, `done` / `failed` at end

Worker path:

1. `spawn_worker` → `agents` (hidden child) + `delegations` (`running`)
2. `runWorker` → `delegations.result` + `status`; oversized reports become `/shared/worker-results/` artifacts
3. `TurnBus` `worker.settled` → private parent cue turn
4. Parent decides whether to summarize, attach an artifact, retry, or stay quiet

Delegate (detached visible teammate turn):

- `delegations` + child `messages` with `viaAgentId`

Queue:

- User `messages.queued` while room busy; `continueQueuedTurn` drains after run ends
