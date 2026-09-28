import {
  agentCreateSchema,
  agentProfileSchema,
  messageCreateSchema,
  roomCreateSchema,
  type AgentProfile,
} from "@nano-agents/shared";

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

export type Proposal = {
  id: string;
  agentId: string;
  kind: string;
  body: string;
  status: string;
};

export type ProviderSetting = {
  provider: "openai" | "anthropic" | "xai" | "local";
  baseUrl: string | null;
  configured: boolean;
};

export type CoreClient = {
  listAgents: (accountId: string) => Promise<RosterAgent[]>;
  hireAgent: (
    accountId: string,
    input: { name: string; description: string; provider: ProviderSetting["provider"]; modelId: string },
  ) => Promise<RosterAgent>;
  listProviders: (accountId: string) => Promise<ProviderSetting[]>;
  saveProvider: (
    accountId: string,
    input: { provider: ProviderSetting["provider"]; secret: string; baseUrl: string | null },
  ) => Promise<ProviderSetting>;
  listConversations: (accountId: string) => Promise<{ id: string; kind: string; ownerAgentId: string }[]>;
  listMessages: (accountId: string, conversationId: string) => Promise<{ id: string; agentId: string | null; body: string; createdAt: string }[]>;
  openChat: (accountId: string, agent: RosterAgent) => Promise<{ id: string }>;
  createGroup: (accountId: string, title: string, agentIds: string[]) => Promise<{ id: string }>;
  sendMessage: (
    accountId: string,
    conversationId: string,
    body: string,
  ) => Promise<{ replies: { id: string; body: string }[] }>;
  mention: (draft: string, name: string) => string;
  listProposals: (accountId: string) => Promise<Proposal[]>;
  approve: (accountId: string, proposalId: string) => Promise<Proposal[]>;
  reject: (accountId: string, proposalId: string) => Promise<Proposal[]>;
  saveProfile: (accountId: string, agentId: string, profile: AgentProfile) => Promise<RosterAgent>;
  screenUrl: (accountId: string, profile: string) => string;
  takeOver: (accountId: string, profile: string) => Promise<void>;
  handBack: (accountId: string, profile: string) => Promise<void>;
};

declare const process: { env: { EXPO_PUBLIC_CORE_URL?: string } };
let readAuthCookie = (): string => "";

/**
 * Connects normal core requests to Better Auth's secure cookie store.
 * Input: a function supplied by the Expo auth client.
 * Output: nothing. Future API calls carry the signed session cookie.
 */
export function configureAuthCookie(reader: () => string): void {
  readAuthCookie = reader;
}

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
    hireAgent: (accountId, input) => hireAgent(baseUrl, accountId, input, fetchImpl),
    listProviders: (accountId) => listProviders(baseUrl, accountId, fetchImpl),
    saveProvider: (accountId, input) => saveProvider(baseUrl, accountId, input, fetchImpl),
    listConversations: (accountId) => listConversations(baseUrl, accountId, fetchImpl),
    listMessages: (accountId, conversationId) => listMessages(baseUrl, accountId, conversationId, fetchImpl),
    openChat: (accountId, agent) => openChat(baseUrl, accountId, agent, fetchImpl),
    createGroup: (accountId, title, agentIds) => createGroup(baseUrl, accountId, title, agentIds, fetchImpl),
    sendMessage: (accountId, conversationId, body) => sendMessage(baseUrl, accountId, conversationId, body, fetchImpl),
    mention,
    listProposals: (accountId) => listProposals(baseUrl, accountId, fetchImpl),
    approve: (accountId, proposalId) => decide(baseUrl, accountId, proposalId, "approve", fetchImpl),
    reject: (accountId, proposalId) => decide(baseUrl, accountId, proposalId, "reject", fetchImpl),
    saveProfile: (accountId, agentId, profile) => saveProfile(baseUrl, accountId, agentId, profile, fetchImpl),
    screenUrl: (accountId, profile) => screenUrl(baseUrl, accountId, profile),
    takeOver: (accountId, profile) => screenFlag(baseUrl, accountId, profile, "takeover", fetchImpl),
    handBack: (accountId, profile) => screenFlag(baseUrl, accountId, profile, "handback", fetchImpl),
  };
}

/**
 * Loads provider configuration without exposing secrets.
 * Input: the core base URL, the account id, and fetch.
 * Output: configured provider names and local base URLs.
 */
async function listProviders(baseUrl: string, accountId: string, fetchImpl: typeof fetch): Promise<ProviderSetting[]> {
  return readJson<ProviderSetting[]>(fetchImpl, `${baseUrl}/accounts/${accountId}/providers`);
}

/**
 * Saves one encrypted provider credential.
 * Input: the core base URL, account id, provider, secret, optional local URL, and fetch.
 * Output: provider metadata only. The secret is never returned.
 */
async function saveProvider(
  baseUrl: string,
  accountId: string,
  input: { provider: ProviderSetting["provider"]; secret: string; baseUrl: string | null },
  fetchImpl: typeof fetch,
): Promise<ProviderSetting> {
  return readJson<ProviderSetting>(fetchImpl, `${baseUrl}/accounts/${accountId}/providers`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
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
 * Hires one agent on the signed-in account.
 * Input: the core base URL, the account id from signup, the name and description, and fetch.
 * Output: the saved agent. The chat creates its Linux profile later.
 */
async function hireAgent(
  baseUrl: string,
  accountId: string,
  input: { name: string; description: string; provider: ProviderSetting["provider"]; modelId: string },
  fetchImpl: typeof fetch,
): Promise<RosterAgent> {
  const body = agentCreateSchema.parse({
    name: input.name,
    label: input.name,
    description: input.description,
    provider: input.provider,
    modelId: input.modelId,
  });
  return readJson<RosterAgent>(fetchImpl, `${baseUrl}/accounts/${accountId}/agents`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Loads the rooms on the signed-in account.
 * Input: the core base URL, the account id, and fetch.
 * Output: the conversations, including each room's owner.
 */
async function listConversations(
  baseUrl: string,
  accountId: string,
  fetchImpl: typeof fetch,
): Promise<{ id: string; kind: string; ownerAgentId: string }[]> {
  return readJson(fetchImpl, `${baseUrl}/accounts/${accountId}/conversations`);
}

/**
 * Loads the saved messages for one room.
 * Input: the core base URL, the account id, the conversation id, and fetch.
 * Output: the messages in time order.
 */
async function listMessages(
  baseUrl: string,
  accountId: string,
  conversationId: string,
  fetchImpl: typeof fetch,
): Promise<{ id: string; agentId: string | null; body: string; createdAt: string }[]> {
  return readJson(fetchImpl, `${baseUrl}/conversations/${conversationId}/messages?accountId=${accountId}`);
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
 * Opens a group on the signed-in account.
 * Input: the core base URL, the account id from signup, the title, the member ids, and fetch.
 * Output: the conversation id. The first member owns the room.
 */
async function createGroup(
  baseUrl: string,
  accountId: string,
  title: string,
  agentIds: string[],
  fetchImpl: typeof fetch,
): Promise<{ id: string }> {
  const ownerAgentId = agentIds[0];
  if (!ownerAgentId) {
    throw new Error("A group needs an agent.");
  }
  const body = roomCreateSchema.parse({
    kind: "group",
    title,
    ownerAgentId,
    memberAgentIds: agentIds,
  });
  return readJson<{ id: string }>(fetchImpl, `${baseUrl}/accounts/${accountId}/conversations`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Sends a chat message, including any @mention in the text.
 * Input: the core base URL, the account id, the conversation id, the message text, and fetch.
 * Output: the replies the core saved for this turn.
 */
async function sendMessage(
  baseUrl: string,
  accountId: string,
  conversationId: string,
  body: string,
  fetchImpl: typeof fetch,
): Promise<{ replies: { id: string; body: string }[] }> {
  const message = messageCreateSchema.parse({ body });
  const saved = await readJson<{ replies?: { id: string; body: string }[] }>(
    fetchImpl,
    `${baseUrl}/conversations/${conversationId}/messages?accountId=${accountId}`,
    {
      method: "POST",
      body: JSON.stringify(message),
    },
  );
  return { replies: saved.replies ?? [] };
}

/**
 * Loads proposals still waiting on this account.
 * Input: the core base URL, the account id, and fetch.
 * Output: the pending proposals.
 */
async function listProposals(baseUrl: string, accountId: string, fetchImpl: typeof fetch): Promise<Proposal[]> {
  return readJson<Proposal[]>(fetchImpl, `${baseUrl}/accounts/${accountId}/proposals`);
}

/**
 * Approves or rejects one proposal, then reloads the pending list.
 * Input: the core base URL, the account id, the proposal id, the decision, and fetch.
 * Output: the pending proposals after the decision. The decided proposal is omitted.
 */
async function decide(
  baseUrl: string,
  accountId: string,
  proposalId: string,
  action: "approve" | "reject",
  fetchImpl: typeof fetch,
): Promise<Proposal[]> {
  await readJson<unknown>(
    fetchImpl,
    `${baseUrl}/proposals/${proposalId}/${action}?accountId=${accountId}`,
    { method: "POST" },
  );
  return listProposals(baseUrl, accountId, fetchImpl);
}

/**
 * Saves the agent's profile on the core.
 * Input: the core base URL, the account id, the agent id, the profile fields, and fetch.
 * Output: the saved agent. The phone does not write prompt files.
 */
async function saveProfile(
  baseUrl: string,
  accountId: string,
  agentId: string,
  profile: AgentProfile,
  fetchImpl: typeof fetch,
): Promise<RosterAgent> {
  const body = agentProfileSchema.parse(profile);
  return readJson<RosterAgent>(fetchImpl, `${baseUrl}/agents/${agentId}?accountId=${accountId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

/**
 * Builds the websocket URL for one profile's desktop.
 * Input: the core base URL, the account id, and the Linux username.
 * Output: a core websocket URL. It uses the core host, not a container port.
 */
export function screenUrl(baseUrl: string, accountId: string, profile: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/accounts/${accountId}/screens/${encodeURIComponent(profile)}`;
  url.search = "";
  return url.toString();
}

/**
 * Takes the pointer or hands it back.
 * Input: the core base URL, the account id, the Linux username, the action, and fetch.
 * Output: nothing. The core pauses or resumes the agent's mouse and keyboard.
 */
async function screenFlag(
  baseUrl: string,
  accountId: string,
  profile: string,
  action: "takeover" | "handback",
  fetchImpl: typeof fetch,
): Promise<void> {
  await readJson<unknown>(
    fetchImpl,
    `${baseUrl}/accounts/${accountId}/screens/${encodeURIComponent(profile)}/${action}`,
    { method: "POST" },
  );
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
  const cookie = readAuthCookie();
  const response = await fetchImpl(url, {
    ...init,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...init?.headers },
  });
  if (!response.ok) {
    const failure = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(failure?.error ?? `Core returned ${response.status}.`);
  }
  return response.json() as Promise<T>;
}
