import { registerTracePlugin } from "./plugins.js";
import { consoleToolCallTracePlugin } from "./sinks/console-tools.js";
import { jsonlTracePlugin } from "./sinks/jsonl.js";

let booted = false;

export function ensureTracePlugins(): void {
  if (booted) return;
  booted = true;
  registerTracePlugin(jsonlTracePlugin);
  registerTracePlugin(consoleToolCallTracePlugin);
}
