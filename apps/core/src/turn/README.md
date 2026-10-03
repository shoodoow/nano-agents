# Turn engine

Dispatcher-first room turns: the chatting agent uses voice tools only; heavy work runs on background workers.

## Layout

| Path | Role |
|------|------|
| `orchestrator.ts` | `runTurn`, run ledger, speaker queue |
| `speaker.ts` | One agent: context → model loop → mentions |
| `agent-loop.ts` | Wires registry + trace harness |
| `tools/registry.ts` | Builds dispatcher tool map (+ MCP/plugins) |
| `tools/build-tools.ts` | Filters `@nano-agents/agent-tools` by surface |
| `tools/executors.ts` | Dispatcher tool side effects (DB writes) |
| `events/emitter.ts` | Durable `events` + SSE fanout |
| `events/bus.ts` | In-process worker/handoff events |
| `trace/` | Plugin-ready execution traces |
| `parent-wake.ts` | Private worker-result cue for manager review |
| `handlers/worker-lifecycle.ts` | Batches `worker.settled` and wakes the parent |

## Extend

- **New tool:** one row in `packages/agent-tools/src/definitions.ts` + execute in `executors.ts` or `linux-tool-executes.ts`.
- **New trace sink:** `registerTracePlugin()` in `trace/plugins.ts`.
- **Skills & plugin tools:** see [GUIDE.md](./GUIDE.md).
- **Persistence map:** see [DB-TRACE.md](./DB-TRACE.md).
