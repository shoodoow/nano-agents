# Plugin tools

Plugin tools extend the **dispatcher** with extra AI SDK tools. Names in the prompt are `{server}_{tool}` (e.g. `demo_echo`).

## Built-in sample

[`apps/core/src/plugins/sample-echo.ts`](../apps/core/src/plugins/sample-echo.ts) registers `demo_echo` — echoes `{ text }` back. Loaded from [`main.ts`](../apps/core/src/main.ts) via `loadBuiltinPlugins()`.

Ask the agent: “Use demo_echo with text hello” (after `send_message` ack per system prompt).

## Add your own

1. Create `apps/core/src/plugins/my-plugin.ts`:

```ts
import { jsonSchema } from "ai";
import { registerPluginTool } from "../turn/plugins/registry.js";

export function registerMyPlugin() {
  registerPluginTool({
    server: "acme",
    name: "ping",
    description: "Returns pong.",
    inputSchema: jsonSchema<{ message?: string }>({
      type: "object",
      properties: { message: { type: "string" } },
    }),
    execute: async (_ctx, input) => ({ pong: true, message: input.message ?? "" }),
  });
}
```

2. Call `registerMyPlugin()` from [`bootstrap.ts`](../apps/core/src/plugins/bootstrap.ts).
3. Restart core. The tool appears in the prompt and in `buildToolSet`.

See [GUIDE.md](../apps/core/src/turn/GUIDE.md) for skills vs plugins vs trace plugins.
