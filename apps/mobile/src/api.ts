import {
  agentCreateSchema,
  agentProfileSchema,
  messageCreateSchema,
  roomCreateSchema,
  type AgentProfile,
  type MessageBlock,
} from "@nano-agents/shared";

export type { MessageBlock };

export type RichMessage = {
  id: string;
  agentId: string | null;
  body: string;
  kind?: string | null;
  payload?: MessageBlock[] | null;
  replyTo?: string | null;
  viaAgentId?: string | null;
  createdAt: string;
};

export type Reaction = {
  id: string;
  messageId: string;
  agentId: string | null;
  emoji: string;
};

export type RosterAgent = {
  id: string;
  name: string;
  label: string;
  role: string;
  personality: string;
  jobDescription: string;
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

export type StreamEvent = {
  type: string;
  message?: RichMessage;
  reaction?: Reaction;
  notification?: PendingNotification;
  run?: { id: string; status: string; error?: string | null };
  error?: string;
  cursor?: number;
};

export type PendingNotification = {
  id: string;
  conversationId: string;
  messageId: string | null;
  runId: string | null;
  title: string;
  body: string;
  urgency: string;
  createdAt: string;
};

export type CoreClient = {
  listAgents: (accountId: string) => Promise<RosterAgent[]>;
  hireAgent: (
    accountId: string,
    input: { name: string; role: string; personality?: string; jobDescription: string; provider: ProviderSetting["provider"]; modelId: string },
  ) => Promise<RosterAgent>;
  hireSubagent: (
    accountId: string,
    parentAgentId: string,
    conversationId: string,
    input: { label: string; role: string; personality?: string; jobDescription: string },
  ) => Promise<RosterAgent>;
  listTeam: (accountId: string, agentId: string) => Promise<RosterAgent[]>;
  listProviders: (accountId: string) => Promise<ProviderSetting[]>;
  saveProvider: (
    accountId: string,
    input: { provider: ProviderSetting["provider"]; secret: string; baseUrl: string | null },
  ) => Promise<ProviderSetting>;
  listConversations: (accountId: string) => Promise<{ id: string; kind: string; title: string; ownerAgentId: string }[]>;
  listMembers: (accountId: string, conversationId: string) => Promise<{ agentId: string }[]>;
  listMessages: (accountId: string, conversationId: string) => Promise<RichMessage[]>;
  blob: (accountId: string, conversationId: string, messageId: string, index: number) => Promise<{
    url?: string;
    previewUrl?: string;
  }>;
  listReactions: (accountId: string, conversationId: string) => Promise<Reaction[]>;
  react: (accountId: string, conversationId: string, messageId: string, emoji: string) => Promise<Reaction>;
  upload: (accountId: string, input: { url: string; name?: string; mime?: string | null }) => Promise<{ url: string }>;
  openChat: (accountId: string, agent: RosterAgent) => Promise<{ id: string }>;
  createGroup: (accountId: string, title: string, agentIds: string[]) => Promise<{ id: string }>;
  sendMessage: (
    accountId: string,
    conversationId: string,
    body: string,
    rich?: { blocks?: MessageBlock[]; replyTo?: string | null },
  ) => Promise<{ accepted: boolean; message: RichMessage; replies?: { id: string; body: string }[] }>;
  subscribeMessages: (
    accountId: string,
    conversationId: string,
    onEvent: (event: StreamEvent) => void,
    opts?: { cursor?: number },
  ) => () => void;
  registerDevice: (accountId: string, input: { expoPushToken: string; platform?: string | null }) => Promise<{ id: string }>;
  listNotifications: (accountId: string) => Promise<PendingNotification[]>;
  mention: (draft: string, name: string) => string;
  listProposals: (accountId: string) => Promise<Proposal[]>;
  approve: (accountId: string, proposalId: string) => Promise<Proposal[]>;
  reject: (accountId: string, proposalId: string) => Promise<Proposal[]>;
  saveProfile: (accountId: string, agentId: string, profile: AgentProfile) => Promise<RosterAgent>;
  screenUrl: (accountId: string, profile: string) => string;
  screenPageUrl: (accountId: string, profile: string) => string;
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
    hireSubagent: (accountId, parentAgentId, conversationId, input) =>
      hireSubagent(baseUrl, accountId, parentAgentId, conversationId, input, fetchImpl),
    listTeam: (accountId, agentId) => listTeam(baseUrl, accountId, agentId, fetchImpl),
    listProviders: (accountId) => listProviders(baseUrl, accountId, fetchImpl),
    saveProvider: (accountId, input) => saveProvider(baseUrl, accountId, input, fetchImpl),
    listConversations: (accountId) => listConversations(baseUrl, accountId, fetchImpl),
    listMembers: (accountId, conversationId) => listMembers(baseUrl, accountId, conversationId, fetchImpl),
    listMessages: (accountId, conversationId) => listMessages(baseUrl, accountId, conversationId, fetchImpl),
    blob: (accountId, conversationId, messageId, index) =>
      fetchBlob(baseUrl, accountId, conversationId, messageId, index, fetchImpl),
    listReactions: (accountId, conversationId) => listReactions(baseUrl, accountId, conversationId, fetchImpl),
    react: (accountId, conversationId, messageId, emoji) =>
      react(baseUrl, accountId, conversationId, messageId, emoji, fetchImpl),
    upload: (accountId, input) => upload(baseUrl, accountId, input, fetchImpl),
    openChat: (accountId, agent) => openChat(baseUrl, accountId, agent, fetchImpl),
    createGroup: (accountId, title, agentIds) => createGroup(baseUrl, accountId, title, agentIds, fetchImpl),
    sendMessage: (accountId, conversationId, body, rich) =>
      sendMessage(baseUrl, accountId, conversationId, body, rich, fetchImpl),
    subscribeMessages: (accountId, conversationId, onEvent, opts) =>
      subscribeMessages(baseUrl, accountId, conversationId, onEvent, fetchImpl, opts),
    registerDevice: (accountId, input) => registerDevice(baseUrl, accountId, input, fetchImpl),
    listNotifications: (accountId) => listNotifications(baseUrl, accountId, fetchImpl),
    mention,
    listProposals: (accountId) => listProposals(baseUrl, accountId, fetchImpl),
    approve: (accountId, proposalId) => decide(baseUrl, accountId, proposalId, "approve", fetchImpl),
    reject: (accountId, proposalId) => decide(baseUrl, accountId, proposalId, "reject", fetchImpl),
    saveProfile: (accountId, agentId, profile) => saveProfile(baseUrl, accountId, agentId, profile, fetchImpl),
    screenUrl: (accountId, profile) => screenUrl(baseUrl, accountId, profile),
    screenPageUrl: (accountId, profile) => screenPageUrl(baseUrl, accountId, profile),
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
 * Why: three identity fields (role/personality/job) replace the old blob.
 * Input: the core base URL, the account id, name/role/personality/job, provider/model, fetch.
 * Output: the saved agent. The chat creates its Linux profile later.
 */
async function hireAgent(
  baseUrl: string,
  accountId: string,
  input: { name: string; role: string; personality?: string; jobDescription: string; provider: ProviderSetting["provider"]; modelId: string },
  fetchImpl: typeof fetch,
): Promise<RosterAgent> {
  const body = agentCreateSchema.parse({
    name: input.name,
    label: input.name,
    role: input.role,
    personality: input.personality ?? "",
    jobDescription: input.jobDescription,
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
 * Output: the conversations, including each room's title and owner.
 */
async function listConversations(
  baseUrl: string,
  accountId: string,
  fetchImpl: typeof fetch,
): Promise<{ id: string; kind: string; title: string; ownerAgentId: string }[]> {
  return readJson(fetchImpl, `${baseUrl}/accounts/${accountId}/conversations`);
}

/**
 * Loads one room's member agent ids for the group header.
 * Why: a group opens with its title plus member names, never disguised as
 * one owner's 1:1 chat.
 * Input: base URL, account id, conversation id, fetch. Output: member rows.
 */
async function listMembers(
  baseUrl: string,
  accountId: string,
  conversationId: string,
  fetchImpl: typeof fetch,
): Promise<{ agentId: string }[]> {
  return readJson(fetchImpl, `${baseUrl}/conversations/${conversationId}/members?accountId=${accountId}`);
}

/**
 * Loads the saved messages for one room with rich payloads.
 * Why: thread renders blocks/images/widgets; body is the text fallback.
 * Input: the core base URL, the account id, the conversation id, and fetch.
 * Output: the messages in time order including kind/payload/replyTo.
 */
async function listMessages(
  baseUrl: string,
  accountId: string,
  conversationId: string,
  fetchImpl: typeof fetch,
): Promise<RichMessage[]> {
  return readJson(fetchImpl, `${baseUrl}/conversations/${conversationId}/messages?accountId=${accountId}`);
}

/**
 * Fetches one stripped attachment's bytes for lazy image rendering.
 * Why: list responses carry blobRefs instead of megabytes; the thread shows
 * previews instantly and each photo loads once, then caches client-side.
 * Input: base URL, ids, block index, fetch. Output: {url?, previewUrl?}.
 */
async function fetchBlob(
  baseUrl: string,
  accountId: string,
  conversationId: string,
  messageId: string,
  index: number,
  fetchImpl: typeof fetch,
): Promise<{ url?: string; previewUrl?: string }> {
  return readJson(
    fetchImpl,
    `${baseUrl}/conversations/${conversationId}/blob/${messageId}/${index}?accountId=${accountId}`,
  );
}

/**
 * Loads tapbacks for one room.
 * Why: reactions render under bubbles without refetching the thread.
 * Input: base URL, account id, conversation id, fetch. Output: reactions.
 */
async function listReactions(
  baseUrl: string,
  accountId: string,
  conversationId: string,
  fetchImpl: typeof fetch,
): Promise<Reaction[]> {
  return readJson(fetchImpl, `${baseUrl}/conversations/${conversationId}/reactions?accountId=${accountId}`);
}

/**
 * Adds one emoji tapback as the human owner.
 * Why: user reactions mirror agent react_to_message; idempotent per emoji.
 * Input: ids + emoji + fetch. Output: saved reaction.
 */
async function react(
  baseUrl: string,
  accountId: string,
  conversationId: string,
  messageId: string,
  emoji: string,
  fetchImpl: typeof fetch,
): Promise<Reaction> {
  return readJson<Reaction>(fetchImpl, `${baseUrl}/conversations/${conversationId}/reactions?accountId=${accountId}`, {
    method: "POST",
    body: JSON.stringify({ messageId, emoji }),
  });
}

/**
 * Registers an image/file URL for use in a block.
 * Why: rows store URLs not bytes; this validates https/data URIs server-side
 * before the client embeds them. Scoped under the account so the session
 * guard can match it (an account-less route can only 403). S3 presigned
 * upload is the later seam.
 * Input: base URL, account id, url/name/mime, fetch. Output: echoed {url}.
 */
async function upload(
  baseUrl: string,
  accountId: string,
  input: { url: string; name?: string; mime?: string | null },
  fetchImpl: typeof fetch,
): Promise<{ url: string }> {
  return readJson(fetchImpl, `${baseUrl}/accounts/${accountId}/uploads`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * Lists the hiring agent's team (children or shared teamId).
 * Why: phone team sheet needs to pick delegates without full roster dump.
 */
async function listTeam(
  baseUrl: string,
  accountId: string,
  agentId: string,
  fetchImpl: typeof fetch,
): Promise<RosterAgent[]> {
  return readJson(fetchImpl, `${baseUrl}/agents/${agentId}/team?accountId=${accountId}`);
}

/**
 * Hires a child specialist into the same room.
 * Why: lets users build Grok-style teams from the phone, not just via model tool.
 */
async function hireSubagent(
  baseUrl: string,
  accountId: string,
  parentAgentId: string,
  conversationId: string,
  input: { label: string; role: string; personality?: string; jobDescription: string },
  fetchImpl: typeof fetch,
): Promise<RosterAgent> {
  return readJson(fetchImpl, `${baseUrl}/agents/${parentAgentId}/subagents?accountId=${accountId}`, {
    method: "POST",
    body: JSON.stringify({ ...input, conversationId }),
  });
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
 * Why: the server saves the user row synchronously and returns it, so the
 * phone swaps the optimistic bubble for the confirmed id — the message can
 * never vanish. Default is 202 background + SSE streaming for agent bubbles.
 * Input: base URL, ids, text, optional rich blocks. Output: accepted flag,
 * the saved user message, plus replies only on the sync path (tests).
 */
async function sendMessage(
  baseUrl: string,
  accountId: string,
  conversationId: string,
  body: string,
  rich: { blocks?: MessageBlock[]; replyTo?: string | null } | undefined,
  fetchImpl: typeof fetch,
): Promise<{ accepted: boolean; message: RichMessage; replies?: { id: string; body: string }[] }> {
  const payload =
    rich?.blocks && rich.blocks.length > 0
      ? { blocks: rich.blocks, replyTo: rich.replyTo ?? null }
      : messageCreateSchema.parse({ body });
  const saved = await readJson<{ accepted?: boolean; message: RichMessage; replies?: { id: string; body: string }[] }>(
    fetchImpl,
    `${baseUrl}/conversations/${conversationId}/messages?accountId=${accountId}`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
  return { accepted: saved.accepted ?? false, message: saved.message, replies: saved.replies };
}

/**
 * Subscribes to live turn events via SSE with cursor resume.
 * Why: progressive multi-bubble turns need push; polling would miss ordering
 * and waste battery. Uses fetch reader so no EventSource polyfill is needed
 * on React Native. Reconnects with backoff resuming from the last cursor, so
 * a dropped connection replays exactly the missed tail (server replays by
 * cursor, client dedups by id). Falls back silently when streaming
 * unsupported (tests).
 * Input: base URL, ids, onEvent, fetch, opts.cursor to resume after.
 * Output: unsubscribe function.
 */
function subscribeMessages(
  baseUrl: string,
  accountId: string,
  conversationId: string,
  onEvent: (event: StreamEvent) => void,
  fetchImpl: typeof fetch,
  opts?: { cursor?: number },
): () => void {
  let cancelled = false;
  let cursor = opts?.cursor ?? 0;
  let attempts = 0;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const pump = async (): Promise<void> => {
    while (!cancelled && attempts < 6) {
      try {
        const cookie = readAuthCookie();
        const response = await fetchImpl(
          `${baseUrl}/conversations/${conversationId}/stream?accountId=${accountId}${cursor > 0 ? `&cursor=${cursor}` : ""}`,
          { headers: { ...(cookie ? { cookie } : {}) }, signal: controller?.signal as never },
        );
        if (!response.ok || !response.body) return;
        attempts = 0;
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done || cancelled) break;
          buffer += decoder.decode(value, { stream: true });
          let index = buffer.indexOf("\n\n");
          while (index >= 0) {
            const chunk = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const line = chunk.split("\n").find((l) => l.startsWith("data: "));
            if (line) {
              try {
                const event = JSON.parse(line.slice(6)) as StreamEvent;
                if (typeof event.cursor === "number" && event.cursor > cursor) {
                  cursor = event.cursor;
                }
                onEvent(event);
              } catch {
                // Malformed keepalive; ignore.
              }
            }
            index = buffer.indexOf("\n\n");
          }
        }
        if (cancelled) return;
        // Clean EOF (server will normally never end a stream): settle before
        // reconnecting instead of hot-spinning the endpoint.
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch {
        // Stream closed mid-flight; back off and resume from the cursor.
      }
      attempts += 1;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempts, 8000)));
    }
  };
  void pump();
  return () => {
    cancelled = true;
    try {
      controller?.abort();
    } catch {
      // Already closed.
    }
  };
}

/**
 * Registers this phone for push delivery.
 * Why: the relay needs an ExpoPushToken per device; without it the user only
 * gets in-app banners. Idempotent upsert server-side (token rotation safe).
 * Input: base URL, account id, token + platform, fetch. Output: device id.
 */
async function registerDevice(
  baseUrl: string,
  accountId: string,
  input: { expoPushToken: string; platform?: string | null },
  fetchImpl: typeof fetch,
): Promise<{ id: string }> {
  return readJson(fetchImpl, `${baseUrl}/devices?accountId=${accountId}`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * Lists pending pings for the badge/inbox fallback.
 * Why: pushes can be missed or dismissed — this is the durable list the phone
 * reconciles on every foreground.
 * Input: base URL, account id, fetch. Output: pending notifications newest-first.
 */
async function listNotifications(
  baseUrl: string,
  accountId: string,
  fetchImpl: typeof fetch,
): Promise<PendingNotification[]> {
  return readJson(fetchImpl, `${baseUrl}/notifications?accountId=${accountId}`);
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
 * Builds the URL of the noVNC viewer page for one profile.
 * Input: the core base URL, the account id, and the Linux username.
 * Output: a core http(s) URL. The page and the socket it opens share an origin
 * so the session cookie the phone holds reaches the core's screen proxy.
 */
export function screenPageUrl(baseUrl: string, accountId: string, profile: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "https:" : "http:";
  url.pathname = `/accounts/${accountId}/screens/${encodeURIComponent(profile)}/client`;
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
