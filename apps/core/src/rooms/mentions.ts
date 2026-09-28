/**
 * Chooses who wakes for one message.
 * Input: the message body, the room members, and the room owner's agent id.
 * Output: mentioned agent ids in first-seen order, or the owner alone when nobody is mentioned.
 */
export function speakers(
  body: string,
  members: { id: string; name: string }[],
  ownerAgentId: string,
): string[] {
  const byName = new Map(members.map((member) => [member.name, member.id]));
  const seen = new Set<string>();
  const order: string[] = [];
  for (const match of body.matchAll(/@([A-Za-z0-9_-]+)/g)) {
    const id = byName.get(match[1] ?? "");
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    order.push(id);
  }
  return order.length > 0 ? order : [ownerAgentId];
}
