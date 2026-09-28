import { messageCreateSchema, roomCreateSchema } from "@nano-agents/shared";

export type RosterAgent = {
  id: string;
  name: string;
  label: string;
  description: string;
  linuxProfile: string | null;
  notify: boolean;
  pinned: boolean;
  hidden: boolean;
};

export type CoreClient = {
  listAgents: (accountId: string) => Promise<RosterAgent[]>;
  openChat: (accountId: string, agent: RosterAgent) => Promise<{ id: string }>;
  sendMessage: (accountId: string, conversationId: string, body: string) => Promise<void>;
  mention: (draft: string, name: string) => string;
};

declare const process: { env: { EXPO_PUBLIC_CORE_URL?: string } };

/**
 * Builds the phone's client for the core HTTP API.
 * Input: an optional core base URL, and an optional fetch implementation.
 * Output: roster, chat, and mention helpers. The client never talks to Docker.
 */
export function createCore(
  baseUrl = process.env.EXPO_PUBLIC_CORE_URL ?? "http://127.0.0.1:3000",
  fetchImpl: typeof fetch = fetch,
): CoreClient {
  return {
    listAgents: (accountId) => listAgents(baseUrl, accountId, fetchImpl),
    openChat: (accountId, agent) => openChat(baseUrl, accountId, agent, fetchImpl),
    sendMessage: (accountId, conversationId, body) => sendMessage(baseUrl, accountId, conversationId, body, fetchImpl),
    mention,
  };
}

/**
 * Loads one account's agents.
 * Input: the core base URL, the account id, and fetch.
 * Output: the agents on that account.
 */
async function listAgents(baseUrl: string, accountId: string, fetchImpl: typeof fetch): Promise<RosterAgent[]> {
  return readJson<RosterAgent[]>(fetchImpl, `${baseUrl}/accounts/${accountId}/agents`);
}

/**
 * Opens a direct chat with one agent.
 * Input: the core base URL, the account id, the agent, and fetch.
 * Output: the conversation id.
 */
async function openChat(
  baseUrl: string,
  accountId: string,
  agent: RosterAgent,
  fetchImpl: typeof fetch,
): Promise<{ id: string }> {
  const body = roomCreateSchema.parse({
    kind: "direct",
    title: agent.name,
    ownerAgentId: agent.id,
    memberAgentIds: [agent.id],
  });
  return readJson<{ id: string }>(fetchImpl, `${baseUrl}/accounts/${accountId}/conversations`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Sends a chat message, including any @mention in the text.
 * Input: the core base URL, the account id, the conversation id, the message text, and fetch.
 * Output: nothing. The core stores the message and wakes the mentioned agents.
 */
async function sendMessage(
  baseUrl: string,
  accountId: string,
  conversationId: string,
  body: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const message = messageCreateSchema.parse({ body });
  await readJson(fetchImpl, `${baseUrl}/conversations/${conversationId}/messages?accountId=${accountId}`, {
    method: "POST",
    body: JSON.stringify(message),
  });
}

/**
 * Inserts an @mention into the composer.
 * Input: the current draft and the agent name.
 * Output: the draft with `@name` at the end when that mention is not already present.
 */
export function mention(draft: string, name: string): string {
  const token = `@${name}`;
  if (draft.includes(token)) {
    return draft;
  }
  const gap = draft.length === 0 || draft.endsWith(" ") ? "" : " ";
  return `${draft}${gap}${token} `;
}

async function readJson<T>(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<T> {
  const response = await fetchImpl(url, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  if (!response.ok) {
    throw new Error(`Core returned ${response.status}.`);
  }
  return response.json() as Promise<T>;
}
