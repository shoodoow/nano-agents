# Turn engine

Dispatcher-first room turns: the chatting agent uses voice tools only; heavy work runs on background workers.

## Layout

| Path | Role |
|------|------|
| `orchestrator.ts` | `runTurn`, run ledger, speaker queue |
| `speaker.ts` | One agent: context → model loop → mentions |
| `agent-loop.ts` | Wires registry + trace harness |
| `tools/catalog.ts` | Single tool list (prompt + SDK) |
| `tools/registry.ts` | AI SDK tools + trace/timing wraps |
| `tools/executors.ts` | Tool side effects (DB writes) |
| `events/emitter.ts` | Durable `events` + SSE fanout |
| `events/bus.ts` | In-process worker/handoff events |
| `trace/` | Plugin-ready execution traces |
| `worker-delivery.ts` | Parent voice delivery to the room |
| `handlers/worker-lifecycle.ts` | Subscribes to `worker.settled` |

## Extend

- **New tool:** add `toolCatalog` entry + executor + schema in `registry.ts`.
- **New trace sink:** `registerTracePlugin()` in `trace/plugins.ts`.
- **Skills & plugin tools:** see [GUIDE.md](./GUIDE.md).
- **Persistence map:** see [DB-TRACE.md](./DB-TRACE.md).
