# Background worker

Legacy default. Built-in specialists live in `prompts/workers/`:

- `executor` — general work
- `computer` — desktop GUI (standing prompt loads `computer-use-linux` skill)
- `browser` — public web first (`chrome-devtools` skill for live pages)
- `explore` — files/code search
- `shell` — commands
- `debug` — evidence-based debugging
- `watch_video` / `video_review` — media
- `vm_setup` — project setup
- `docs` — documentation research
- `custom` — parent-supplied standing method via spawn_worker `instructions`

Runtime loads `prompts/workers/<kind>.md` (see `apps/core/src/rooms/worker-kinds.ts`).
