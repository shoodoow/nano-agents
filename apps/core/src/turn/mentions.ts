/**
 * Mention routing for multi-speaker turns.
 * Why: extracted from monolithic turn.ts. DB: none.
 */
import { addressedIds } from "../rooms/mentions.js";

/**
 * Teammates a message hands the floor to.
 * Why: "Looks good. @Creator, over to you" is a handoff even though the name
 * does not open the message; a name dropped mid-sentence is not.
 * Input: message text, room members, the speaker to leave out. Output: agent ids.
 */
export function mentionedAgents(
  body: string,
  memberRows: { id: string; name: string; label?: string | null }[],
  _onlyLeading = false,
  selfId?: string,
): string[] {
  return addressedIds(body, memberRows).filter((id) => id !== selfId);
}
