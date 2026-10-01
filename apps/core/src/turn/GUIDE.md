# Turn engine — how it works

## End-to-end flow

```text
POST /messages
  → runs (claim slot)
  → messages (user row)
  → runTurn (orchestrator)
       → speakOnce (per @mentioned agent)
            → buildContext (system + identity + tool names + skill catalog in prefix; room + summary + thread in tail)
            → runAgentLoop
                 → buildToolSet("dispatcher")  — built-in tools only today
                 → runModelHarness (AI SDK generateText + trace plugins)
                      → tool execute → DB (messages, delegations, …) + TurnEmitter → events + SSE
       → spawn_worker → runWorker (background)
            → worker tools (bash, web, read_skill, …)
            → delegations.result (report to parent)
            → TurnBus worker.settled → deliverWorkerResult or parent wake
  → runs (done) + events (run done)
```

**Dispatcher** (chat agent): voice tools (`send_message`, …), team tools, `spawn_worker`. No direct bash/web/desktop on the dispatcher loop (workers do that).

**Worker**: computer tools + `read_history` / `read_skill`. No `send_message`.

**Persistence:** see [DB-TRACE.md](./DB-TRACE.md).

---

## Skills (procedures)

Skills are **markdown playbooks** on disk. The model sees **names + descriptions** in the cached prompt prefix; full steps load only when it calls `read_skill`.

### Layout

Set `SKILLS_DIR` to a directory (e.g. repo root `skills/`):

```text
skills/
  my-skill/
    SKILL.md          # shared (all accounts)
  accounts/
    <account-uuid>/
      my-skill/
        SKILL.md      # overrides shared same name for that account
```

Each `SKILL.md` must start with YAML frontmatter:

```yaml
---
name: my-skill
description: One line for the catalog in the system prompt.
---
```

Body = instructions the agent follows after `read_skill`.

### Runtime

| Step | What happens |
|------|----------------|
| Turn start | `skillCatalogForAccount(SKILLS_DIR, accountId)` → lines in prompt prefix |
| Agent calls `read_skill({ name: "my-skill" })` | `readSkillForAccount` returns body (account override wins) |
| Worker | Same `read_skill` in worker toolset when `SKILLS_DIR` is set |

Core passes `process.env.SKILLS_DIR` from [`server.ts`](../../http/server.ts) into `runTurn`.

**Sample:** [`../../../../skills/sample-greeting/SKILL.md`](../../../../skills/sample-greeting/SKILL.md) in this repo.

---

## Plugin tools (MCP catalog)

**Today:** plugin tools are merged into the **prompt tool list** only, via [`listTools`](../../skills/tools.ts). Names are `{server}_{tool}` (e.g. `crm_search`) so caches stay stable and collisions are avoided.

```ts
import { listTools } from "../skills/tools.js";

const plugins = [
  { server: "crm", tools: [{ name: "search_contacts", description: "Search CRM contacts by email or name." }] },
];

const catalog = listTools(plugins); // sorted; includes send_message, spawn_worker, … + crm_search_contacts
```

Use `catalog.map((t) => t.name)` when building `buildContext({ tools: [...] })` if you wire plugins at the HTTP layer.

**In-process plugins (working):** call [`registerPluginTool`](./plugins/registry.ts) before turns run. Tools are exposed as `{server}_{name}` in both the prompt and `buildToolSet`. Sample: **`demo_echo`** in [`plugins/sample-echo.ts`](../../plugins/sample-echo.ts), loaded from [`plugins/bootstrap.ts`](../../plugins/bootstrap.ts). See [`plugins/README.md`](../../../../plugins/README.md).

Remote MCP servers are not connected yet; use `registerPluginTool` for local executors or bridge MCP calls inside `execute`.

### Adding a built-in tool (fully working)

1. [`tools/catalog.ts`](./tools/catalog.ts) — `name`, `description`, `modes: ["dispatcher"]`
2. [`tools/executors.ts`](./tools/executors.ts) — `execute…(ctx, input)`
3. [`tools/registry.ts`](./tools/registry.ts) — JSON schema + map in `dispatcherExecutors`

Prompt prefix picks up names via `listToolNames("dispatcher")` in [`speaker.ts`](./speaker.ts).

---

## Trace plugins (execution inspect — works today)

Unlike MCP plugin *tools*, **trace plugins** hook every model step and tool call (DeepSeek-style harness).

```ts
import { registerTracePlugin } from "../turn/index.js";

registerTracePlugin({
  name: "my-inspect",
  async onEvent(ctx, event) {
    if (event.type === "tool.call.finish") {
      console.log(ctx.runId, event.name, event.durationMs, event.outputPreview);
    }
  },
});
```

Register before the first `runTurn` (e.g. in `main.ts` after imports). Default **jsonl** sink writes to `apps/core/.tool-trace.log`. Plugins must not throw (failures are isolated with `allSettled`).

Event types: `run.start`, `model.step.finish`, `tool.call.start`, `tool.call.finish`, `run.finish`, `run.error` — see [`trace/types.ts`](./trace/types.ts).

---

## Quick reference

| Goal | Mechanism |
|------|-----------|
| Talk to user | `send_message` only (see `prompts/system.md`) |
| Long work | `spawn_worker` with detailed `task` brief |
| Procedure | Skill folder + `read_skill` |
| Extra tool names in prompt | `listTools(mcpPlugins)` in context |
| Extra tool **execution** | Registry executor (built-in) or future MCP bridge |
| Debug a turn | `.tool-trace.log` or custom `registerTracePlugin` |
