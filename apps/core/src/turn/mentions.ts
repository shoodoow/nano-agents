/**
 * Mention routing for multi-speaker turns.
 * Why: extracted from monolithic turn.ts. DB: none.
 */
import { speakers } from "../rooms/mentions.js";

export function mentionedAgents(
  body: string,
  memberRows: { id: string; name: string }[],
  onlyLeading = false,
): string[] {
  if (!onlyLeading) {
    return speakers(body, memberRows, "").filter((id) => id !== "");
  }
  const leading = /^\s*@([A-Za-z0-9_-]+)/.exec(body)?.[1] ?? "";
  const member = memberRows.find((row) => row.name === leading);
  return member ? [member.id] : [];
}
