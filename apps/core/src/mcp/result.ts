/**
 * Normalize MCP callTool results for the AI SDK tool executor.
 */
type ContentBlock = { type: string; text?: string; [key: string]: unknown };

export function formatMcpToolResult(result: {
  isError?: boolean;
  content?: ContentBlock[];
  structuredContent?: unknown;
  [key: string]: unknown;
}): unknown {
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    if (result.isError) {
      return { error: result.structuredContent };
    }
    return result.structuredContent;
  }
  const text = (result.content ?? [])
    .map((block) => (block.type === "text" && block.text ? block.text : JSON.stringify(block)))
    .join("\n")
    .trim();
  if (result.isError) {
    return { error: text || "MCP tool failed." };
  }
  if (!text) return { ok: true };
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}
