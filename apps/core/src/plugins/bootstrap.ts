import { registerSampleEchoPlugin } from "./sample-echo.js";

let loaded = false;

/** Loads bundled sample plugins. Add real MCP bridges here later. */
export function loadBuiltinPlugins(): void {
  if (loaded) return;
  loaded = true;
  registerSampleEchoPlugin();
}
