import { generateText } from "ai";
import { and, asc, eq } from "drizzle-orm";
import { buildInstructions } from "./build-instructions.js";
import type { getDb } from "./db/client.js";
import { agents, conversations, members, messages } from "./db/schema.js";
import { getModel } from "./get-model.js";
import { speakers } from "./mentions.js";

type Db = ReturnType<typeof getDb>;

export type TurnInput = {
  agentId: string;
  provider: string;
  modelId: string;
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
};

/**
 * Runs one room turn.
 * Input: database, account id, conversation id, the incoming message, and an optional model call.
 * Output: the replies saved for this turn, one per woken agent, in speaker order.
 * The conversation row stays locked until every reply is saved.
 */
export async function runTurn(
  db: Db,
  accountId: string,
  conversationId: string,
  body: string,
  generate: (input: TurnInput) => Promise<string> = replyWithModel,
) {
  return db.transaction(async (tx) => {
    const [room] = await tx
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId)))
      .for("update");
    if (!room) {
      throw new Error("Room not found");
    }

    const memberRows = await tx
      .select({ id: agents.id, name: agents.name })
      .from(members)
      .innerJoin(agents, eq(members.agentId, agents.id))
      .where(and(eq(members.conversationId, conversationId), eq(members.accountId, accountId)));

    let stamp = Date.now();
    const nextTime = () => new Date(stamp++);
    await tx.insert(messages).values({
      accountId,
      conversationId,
      agentId: null,
      body,
      createdAt: nextTime(),
    });

    const spoken = new Set<string>();
    const queue = speakers(body, memberRows, room.ownerAgentId);
    const replies = [];
    while (queue.length > 0) {
      const agentId = queue.shift();
      if (!agentId || spoken.has(agentId)) {
        continue;
      }
      spoken.add(agentId);
      const [agent] = await tx.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.accountId, accountId)));
      if (!agent) {
        throw new Error("Agent not found");
      }
      const history = await tx
        .select()
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), eq(messages.accountId, accountId)))
        .orderBy(asc(messages.createdAt));
      const text = await generate({
        agentId,
        provider: agent.provider,
        modelId: agent.modelId,
        system: buildInstructions(agent.description),
        messages: history.map((message) => ({
          role: message.agentId ? "assistant" : "user",
          content: message.body,
        })),
      });
      const [saved] = await tx
        .insert(messages)
        .values({
          accountId,
          conversationId,
          agentId,
          body: text,
          createdAt: nextTime(),
        })
        .returning();
      replies.push(saved!);
      for (const next of mentioned(text, memberRows)) {
        if (!spoken.has(next)) {
          queue.push(next);
        }
      }
    }
    return replies;
  });
}

function mentioned(body: string, memberRows: { id: string; name: string }[]): string[] {
  return speakers(body, memberRows, "").filter((id) => id !== "");
}

async function replyWithModel(input: TurnInput): Promise<string> {
  const result = await generateText({
    model: getModel(input.provider, input.modelId),
    system: input.system,
    messages: input.messages,
  });
  return result.text;
}
