import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createXai } from "@ai-sdk/xai";
import type { LanguageModel } from "ai";

/**
 * Returns the Vercel AI SDK model for one provider name and model id.
 * Input: provider name and model id. Output: the SDK model object used by generateText.
 * This is the only place that chooses a provider package.
 */
export function getModel(provider: string, modelId: string, apiKey = "", baseUrl?: string | null): LanguageModel {
  switch (provider) {
    case "openai":
      return createOpenAI({ apiKey })(modelId);
    case "anthropic":
      return createAnthropic({ apiKey })(modelId);
    case "xai":
      return createXai({ apiKey })(modelId);
    case "local":
      return createOpenAI({ apiKey: apiKey || "local", baseURL: baseUrl ?? undefined })(modelId);
    default:
      throw new Error(`Unknown provider ${provider}`);
  }
}
