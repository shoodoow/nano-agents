/**
 * Pluggable execution trace sinks (JSONL default; inspect UI later).
 * Why: plugins must never fail a turn — allSettled fanout.
 */
import type { TraceContext, TraceEvent } from "./types.js";

export type TracePlugin = {
  name: string;
  onEvent(ctx: TraceContext, event: TraceEvent): void | Promise<void>;
};

const plugins: TracePlugin[] = [];

export function registerTracePlugin(plugin: TracePlugin): void {
  plugins.push(plugin);
}

export function listTracePlugins(): readonly TracePlugin[] {
  return plugins;
}

export type TraceSession = {
  ctx: TraceContext;
  emit(event: TraceEvent): Promise<void>;
};

export function createTraceSession(ctx: TraceContext): TraceSession {
  return {
    ctx,
    async emit(event) {
      await Promise.allSettled(plugins.map((plugin) => plugin.onEvent(ctx, event)));
    },
  };
}
