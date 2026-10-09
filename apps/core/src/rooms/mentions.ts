type Mentionable = { id: string; name: string; label?: string | null };

const squash = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Finds the member an @token points at.
 * Why: handles carry a random suffix ("Reviewer-969e") that models and people
 * drop. "@Reviewer", "@reviewer" and the label all mean the same teammate, and
 * a mention that matches nobody silently wakes nobody.
 * Input: the token after "@" and the room members. Output: member id or null.
 */
export function resolveMention(token: string, members: Mentionable[]): string | null {
  const exact = members.find((member) => member.name === token);
  if (exact) return exact.id;
  const wanted = squash(token);
  if (!wanted) return null;
  const matches = members.filter((member) => {
    const base = member.name.replace(/-[a-z0-9]{4}$/i, "");
    return squash(member.name) === wanted || squash(base) === wanted || squash(member.label ?? "") === wanted;
  });
  // Two teammates answering to one short name is ambiguous; wake neither by guess.
  return matches.length === 1 ? matches[0]!.id : null;
}

/** Every member mentioned in a message, in first-seen order. */
export function mentionedIds(body: string, members: Mentionable[]): string[] {
  const order: string[] = [];
  for (const match of body.matchAll(/@([A-Za-z0-9_-]+)/g)) {
    const id = resolveMention(match[1] ?? "", members);
    if (id && !order.includes(id)) order.push(id);
  }
  return order;
}

/**
 * Members a message is addressed to: "@name" opening the message, a line, or
 * a sentence ("Looks good. @Creator, over to you").
 * Why: agents also name teammates in passing ("thanks @Bea for the help").
 * Treating that as a handoff made two agents thank each other in a loop.
 */
export function addressedIds(body: string, members: Mentionable[]): string[] {
  const order: string[] = [];
  for (const match of body.matchAll(/(?:^|\n|[.!?:]\s+)\s*@([A-Za-z0-9_-]+)/g)) {
    const id = resolveMention(match[1] ?? "", members);
    if (id && !order.includes(id)) order.push(id);
  }
  return order;
}

/**
 * Chooses who wakes for one message.
 * Input: the message body, the room members, and the room owner's agent id.
 * Output: mentioned agent ids in first-seen order, or the owner alone when nobody is mentioned.
 */
export function speakers(body: string, members: Mentionable[], ownerAgentId: string): string[] {
  const order = mentionedIds(body, members);
  return order.length > 0 ? order : [ownerAgentId];
}
