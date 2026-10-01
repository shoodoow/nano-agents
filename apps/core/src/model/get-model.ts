import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createXai } from "@ai-sdk/xai";
import type { LanguageModel } from "ai";

/** OpenAI SDK–compatible providers (custom base URL + chat/completions). */
export function isOpenAiCompatibleProvider(provider: string): boolean {
  return provider === "openai" || provider === "local";
}

/** True when calls should hit the default OpenAI API (prompt cache, etc.). */
export function usesOfficialOpenAiEndpoint(provider: string, baseUrl?: string | null): boolean {
  return provider === "openai" && !baseUrl?.trim();
}

function openAiCompatibleModel(modelId: string, apiKey: string, baseUrl?: string | null, placeholderKey = ""): LanguageModel {
  const trimmedBase = baseUrl?.trim();
  const key = apiKey.trim() || placeholderKey || undefined;
  return createOpenAI({
    ...(key ? { apiKey: key } : {}),
    ...(trimmedBase ? { baseURL: trimmedBase } : {}),
  })(modelId);
}

/**
 * Returns the Vercel AI SDK model for one provider name and model id.
 * Input: provider name and model id. Output: the SDK model object used by generateText.
 * This is the only place that chooses a provider package.
 *
 * For `openai`, an optional base URL (e.g. NVIDIA `https://integrate.api.nvidia.com/v1`) uses the
 * OpenAI-compatible client with your API key and model id (e.g. `nvidia/nemotron-3-super-120b-a12b`).
 */
export function getModel(provider: string, modelId: string, apiKey = "", baseUrl?: string | null): LanguageModel {
  switch (provider) {
    case "openai":
      return openAiCompatibleModel(modelId, apiKey, baseUrl);
    case "anthropic":
      return createAnthropic({ apiKey })(modelId);
    case "xai":
      return createXai({ apiKey })(modelId);
    case "local":
      return openAiCompatibleModel(modelId, apiKey, baseUrl, "local");
    default:
      throw new Error(`Unknown provider ${provider}`);
  }
}
