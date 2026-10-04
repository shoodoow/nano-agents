/**
 * Pluggable model capacity registry.
 * Why: the core never hardcodes every model's context window — providers ship
 * new ids monthly and local endpoints report nothing. Built-ins cover the
 * well-known families as estimates; account-specific plugins override via
 * registerModelInfoProvider (first non-null wins, built-ins are the fallback).
 * Display labels the source so "unknown" is never presented as fact.
 */

export type ModelInfo = {
  /** Billable context window in tokens, or null when unknown. */
  contextWindow: number | null;
  /** Where the number came from: plugin override, builtin estimate, unknown. */
  source: "gateway" | "plugin" | "builtin-estimate" | "unknown";
};

export type ModelInfoProvider = {
  name: string;
  contextWindowFor(provider: string, modelId: string): number | null;
};

const providers: ModelInfoProvider[] = [];

export function registerModelInfoProvider(provider: ModelInfoProvider): void {
  providers.unshift(provider);
}

export function listModelInfoProviders(): readonly ModelInfoProvider[] {
  return providers;
}

/** Conservative built-in estimates for well-known families. Local = unknown. */
function builtinEstimate(provider: string, modelId: string): number | null {
  const id = modelId.toLowerCase();
  if (provider === "anthropic") return 200_000;
  if (provider === "xai") return 131_072;
  if (provider === "openai") {
    if (/^o1|^o3/.test(id)) return 200_000;
    return 128_000;
  }
  return null;
}

export function modelInfoFor(
  provider: string,
  modelId: string,
  storedContextWindow?: number | null,
): ModelInfo {
  if (typeof storedContextWindow === "number" && storedContextWindow > 0) {
    return { contextWindow: Math.floor(storedContextWindow), source: "gateway" };
  }
  for (const providerPlugin of providers) {
    if (providerPlugin.name === "vercel-ai-gateway") {
      const value = providerPlugin.contextWindowFor(provider, modelId);
      if (typeof value === "number" && value > 0) {
        return { contextWindow: Math.floor(value), source: "gateway" };
      }
      continue;
    }
    const value = providerPlugin.contextWindowFor(provider, modelId);
    if (typeof value === "number" && value > 0) {
      return { contextWindow: Math.floor(value), source: "plugin" };
    }
  }
  const builtin = builtinEstimate(provider, modelId);
  if (builtin !== null) return { contextWindow: builtin, source: "builtin-estimate" };
  return { contextWindow: null, source: "unknown" };
}
