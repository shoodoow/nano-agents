import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, SafeAreaView, StatusBar, StyleSheet, Text } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import {
  configureAuthCookie,
  contextLine as formatContextLine,
  createCore,
  type MessageBlock,
  type Proposal,
  type ProviderSetting,
  type Reaction,
  type RichMessage,
  type RosterAgent,
  type Routine,
  type ToolApproval,
} from "./src/api";
import { blocksFromMaybeWidgetText, expandWidgetMarkupBlocks } from "@nano-agents/shared";
import { configureForegroundBanners, getPushToken, onPushTap } from "./src/push";
import { authClient } from "./src/auth";
import { MenuSheet, type MenuPage, type SignedAccount } from "./src/account/MenuSheet";
import { ApprovalsScreen } from "./src/approvals/ApprovalsScreen";
import { BotInfoScreen } from "./src/chat/BotInfoScreen";
import { GroupInfoScreen } from "./src/chat/GroupInfoScreen";
import { ChatScreen, type Bubble } from "./src/chat/ChatScreen";
import { DesktopScreen } from "./src/desktop/DesktopScreen";
import { InboxScreen } from "./src/inbox/InboxScreen";
import { NewRoomSheet } from "./src/inbox/NewRoomSheet";
import { colors } from "./src/theme/tokens";
import type { GroupFace } from "./src/ui/GroupCluster";

configureAuthCookie(authClient.getCookie);
const core = createCore();

/**
 * Turns one saved row into a bubble, resolving reply quotes and names.
 * Why: shared by full refreshes and live SSE appends so streamed bubbles look
 * identical to reloaded ones. Reactions attach separately (fetched in bulk).
 * Input: row, id lookup, reactions-by-message, roster. Output: one bubble.
 */
function toBubble(
  row: RichMessage,
  byId: Map<string, RichMessage>,
  byMessage: Map<string, Reaction[]>,
  roster: RosterAgent[],
): Bubble {
  const parent = row.replyTo ? byId.get(row.replyTo) : undefined;
  const rawBlocks: MessageBlock[] | null =
    row.kind === "rich" && Array.isArray(row.payload) ? (row.payload as MessageBlock[]) : null;
  const blocks: MessageBlock[] | null = rawBlocks
    ? (expandWidgetMarkupBlocks(rawBlocks) as MessageBlock[])
    : row.body.includes("[widget:")
      ? blocksFromMaybeWidgetText(row.body)
      : null;
  return {
    id: row.id,
    author: row.agentId ? (roster.find((agent) => agent.id === row.agentId)?.name ?? "Agent") : "You",
    agentId: row.agentId,
    mine: row.agentId === null,
    body: row.body,
    sortAt: row.createdAt,
    time: new Date(row.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }),
    blocks,
    replyTo: row.replyTo ?? null,
    replyPreview: parent?.body.slice(0, 80) ?? null,
    via: row.viaAgentId ? (roster.find((agent) => agent.id === row.viaAgentId)?.name ?? null) : null,
    reactions: byMessage.get(row.id) ?? [],
  };
}

/**
 * Turns saved rich rows into chat bubbles with reply context.
 * Why: thread shows blocks/images/widgets inline plus quoted parents and
 * tapbacks; body stays the fallback for text-only rows.
 * Input: message rows, reactions, roster, by-id lookup. Output: bubbles.
 */
function toBubbles(
  rows: RichMessage[],
  reactions: Reaction[],
  roster: RosterAgent[],
): Bubble[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const byMessage = new Map<string, Reaction[]>();
  for (const reaction of reactions) {
    const list = byMessage.get(reaction.messageId) ?? [];
    list.push(reaction);
    byMessage.set(reaction.messageId, list);
  }
  return rows.map((row) => toBubble(row, byId, byMessage, roster));
}

function sortBubbles(bubbles: Bubble[]): Bubble[] {
  return [...bubbles].sort((left, right) => left.sortAt.localeCompare(right.sortAt) || left.id.localeCompare(right.id));
}

export type Attachment = {
  id: string;
  kind: "image" | "file";
  url: string;
  name?: string;
  mime?: string | null;
};

type Screen =
  | { name: "inbox" }
  | {
      name: "chat";
      agent: RosterAgent;
      conversationId: string;
      kind: "direct" | "group";
      title: string;
      subtitle: string;
      memberIds: string[];
    }
  | { name: "desktop"; agent: RosterAgent }
  | { name: "profile"; agent: RosterAgent; fromGroup?: boolean }
  | {
      name: "group";
      conversationId: string;
      title: string;
      memberIds: string[];
      owner: RosterAgent;
    }
  | { name: "approvals" };

/**
 * Shows the roster, a chat, approvals, a profile, and the live desktop.
 * Input: none. The core URL comes from EXPO_PUBLIC_CORE_URL.
 * Output: the phone screens for those actions.
 */
export default function App() {
  const [accounts, setAccounts] = useState<SignedAccount[]>([]);
  const [accountId, setAccountId] = useState("");
  const [agents, setAgents] = useState<RosterAgent[]>([]);
  const [providers, setProviders] = useState<ProviderSetting[]>([]);
  const [screen, setScreen] = useState<Screen>({ name: "inbox" });
  const [menu, setMenu] = useState<MenuPage | null>(null);
  const [creating, setCreating] = useState(false);
  const [afterSignup, setAfterSignup] = useState(false);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<Bubble[]>([]);
  const [sending, setSending] = useState(false);
  const [typing, setTyping] = useState(false);
  // Why: the open chat must keep merging server rows after send() returns.
  // A one-shot watcher stopped before a late reply, so it only appeared on reopen.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const expectReply = useRef(false);
  const [replyTo, setReplyTo] = useState<Bubble | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachOpen, setAttachOpen] = useState(false);
  const [note, setNote] = useState("");
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [toolApprovals, setToolApprovals] = useState<ToolApproval[]>([]);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [groupFeed, setGroupFeed] = useState<(Bubble & { conversationId?: string })[]>([]);
  const [profileFeed, setProfileFeed] = useState<(Bubble & { conversationId?: string })[]>([]);
  const [profile, setProfile] = useState<RosterAgent | null>(null);
  const [conversationId, setConversationId] = useState("");
  const [contextLine, setContextLine] = useState<string | null>(null);
  const [groups, setGroups] = useState<{ id: string; title: string; memberCount: number; members: GroupFace[] }[]>([]);
  // Last opened chat, so the desktop back-button returns to the right title.
  const [lastChat, setLastChat] = useState<{
    agent: RosterAgent;
    conversationId: string;
    kind: "direct" | "group";
    title: string;
    subtitle: string;
    memberIds: string[];
  } | null>(null);
  const [notifications, setNotifications] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const [autoReview, setAutoReview] = useState(true);
  const [autoTimeZone, setAutoTimeZone] = useState(true);
  const account = accounts.find((row) => row.id === accountId) ?? null;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  /**
   * Shows a request error on the screen.
   * Input: the thrown value.
   * Output: nothing. The note becomes the error message.
   */
  const show = useCallback((error: unknown): void => {
    setNote(error instanceof Error ? error.message : "The request failed.");
  }, []);

  /**
   * Loads the Google session and the roster for that account id.
   * Input: none. It reads the session stored on the phone.
   * Output: nothing. The inbox shows the signed-in account.
   */
  async function refreshSession(): Promise<void> {
    const session = await authClient.getSession();
    const signed = session.data?.user;
    const accountIdFromSession = signed && "accountId" in signed ? String(signed.accountId ?? "") : "";
    if (!signed || !accountIdFromSession) {
      return;
    }
    const next = { id: accountIdFromSession, name: signed.name, email: signed.email };
    setAccounts([next]);
    setAccountId(accountIdFromSession);
    const [roster, configured, settings] = await Promise.all([
      core.listAgents(accountIdFromSession),
      core.listProviders(accountIdFromSession),
      core.getSettings(accountIdFromSession).catch(() => ({ autoReview: true })),
    ]);
    setAgents(roster);
    setProviders(configured);
    setAutoReview(settings.autoReview);
    setScreen({ name: "inbox" });
    setMenu(null);
    setNote("");
    await loadGroups(accountIdFromSession, roster);
    // Best-effort push registration + badge: no EAS projectId, denied
    // permission, or network failure all degrade to SSE/polling silently.
    try {
      const push = await getPushToken();
      if (push) {
        await core.registerDevice(accountIdFromSession, { expoPushToken: push.token, platform: push.platform });
      }
      const pending = await core.listNotifications(accountIdFromSession).catch(() => []);
      setPendingCount(pending.length);
    } catch {
      // Push unavailable; the thread still streams when open.
    }
  }

  /**
   * Signs in with Google and keeps the account id the core creates.
   * Input: none. Google returns the session.
   * Output: nothing. Later chats and groups use that account id.
   */
  async function signInWithGoogle(): Promise<void> {
    const callbackURL = Platform.OS === "web" ? globalThis.location.origin : "nano-agents://";
    const result = await authClient.signIn.social({ provider: "google", callbackURL });
    if (result.error) {
      throw new Error(result.error.message ?? "Google sign in failed.");
    }
    await refreshSession();
    if (afterSignup) {
      setAfterSignup(false);
      setCreating(true);
    }
  }

  useEffect(() => {
    void refreshSession().catch(show);
  }, [show]);

  useEffect(() => {
    configureForegroundBanners();
    return onPushTap((data) => {
      // A push tap carries the exact room — open it instead of the inbox.
      // Badge reconciles on foreground; the room shows the full result.
      const conversationId = typeof data.conversationId === "string" ? data.conversationId : null;
      if (!conversationId) return;
      void openGroup(conversationId).catch(show);
    });
  }, [show]);

  /**
   * Loads the roster for one signed-in account.
   * Input: the account id chosen in the switcher.
   * Output: nothing. The inbox shows that account's agents.
   */
  async function switchAccount(id: string): Promise<void> {
    setAccountId(id);
    const roster = await core.listAgents(id);
    setAgents(roster);
    setProviders(await core.listProviders(id));
    setScreen({ name: "inbox" });
    setMenu("menu");
    setNote("");
    await loadGroups(id, roster);
    const pending = await core.listNotifications(id).catch(() => []);
    setPendingCount(pending.length);
  }

  /**
   * Hires an agent and opens a direct chat on the signed-in account.
   * Why: role + job ship with the hire so the agent starts with identity, not a blob.
   * Input: the agent name, role, and job from the new-room sheet.
   * Output: nothing. The chat screen opens for that agent.
   */
  async function createChat(
    name: string,
    role: string,
    jobDescription: string,
    provider: ProviderSetting["provider"],
    modelId: string,
  ): Promise<void> {
    const hired = await core.hireAgent(accountId, { name, role, jobDescription, provider, modelId });
    const room = await core.openChat(accountId, hired);
    const rows = await core.listAgents(accountId);
    const fresh = rows.find((row) => row.id === hired.id) ?? hired;
    setAgents(rows);
    await enterRoom({ id: room.id, kind: "direct", title: fresh.name, ownerAgentId: fresh.id }, rows);
    setCreating(false);
    await loadGroups(accountId, rows);
  }

  /**
   * Opens a group for the chosen agents on the signed-in account.
   * Input: the group title and the member ids.
   * Output: nothing. The chat screen opens on that group.
   */
  async function createGroup(title: string, agentIds: string[]): Promise<void> {
    const room = await core.createGroup(accountId, title, agentIds);
    const rows = await core.listAgents(accountId);
    setAgents(rows);
    await enterRoom({ id: room.id, kind: "group", title, ownerAgentId: agentIds[0]! }, rows);
    setCreating(false);
    await loadGroups(accountId, rows);
  }

  /**
   * Loads one thread as bubbles without touching state.
   * Why: shared by full refreshes and the native poll loop so both merge the
   * same way. Input: room id + roster. Output: fresh bubbles.
   */
  async function loadThread(roomId: string, roster: RosterAgent[]): Promise<Bubble[]> {
    const [history, taps] = await Promise.all([
      core.listMessages(accountId.trim(), roomId),
      core.listReactions(accountId.trim(), roomId),
    ]);
    return toBubbles(history, taps, roster);
  }

  /**
   * Merges server bubbles over the current thread.
   * Why: MERGE, never replace — streamed/polled bubbles arrive before later
   * refreshes, and replacing would wipe them (the old vanishing glitch).
   * Server rows win on id conflicts; local-only rows (pending, fresh agent
   * bubbles) are kept. Input: fresh server bubbles. Output: nothing.
   */
  function mergeThread(fresh: Bubble[]): void {
    setMessages((current) => {
      const byId = new Map(fresh.map((bubble) => [bubble.id, bubble]));
      const merged = [...fresh];
      for (const bubble of current) {
        if (!byId.has(bubble.id)) {
          merged.push(bubble);
        }
      }
      return sortBubbles(merged);
    });
  }

  /**
   * Reloads one thread with messages + reactions, merging into current state.
   * Input: room id + roster. Output: nothing.
   */
  async function refreshThread(roomId: string, roster: RosterAgent[]): Promise<void> {
    mergeThread(await loadThread(roomId, roster));
  }

  const liveRoomId = screen.name === "chat" ? screen.conversationId : "";

  /**
   * Keeps the open chat matched to the server while the room stays on screen.
   * Why: agent bubbles commit as the turn runs; polling merges them in true
   * createdAt order so a slow reply never jumps above newer user messages.
   * Input: the open room id. Output: nothing. Stops on leave.
   */
  useEffect(() => {
    if (!liveRoomId) return;
    const account = accountId.trim();
    if (!account) return;
    let stopped = false;
    const known = new Set(messagesRef.current.map((bubble) => bubble.id));
    const pull = async (): Promise<void> => {
      try {
        const [history, taps] = await Promise.all([
          core.listMessages(account, liveRoomId),
          core.listReactions(account, liveRoomId),
        ]);
        if (stopped) return;
        const fresh = toBubbles(history, taps, agentsRef.current);
        if (expectReply.current && fresh.some((bubble) => !bubble.mine && !known.has(bubble.id))) {
          expectReply.current = false;
          setTyping(false);
          // Turn landed: usage changed, refresh the header line once.
          void loadContextLine(liveRoomId);
        }
        for (const bubble of fresh) known.add(bubble.id);
        mergeThread(fresh);
      } catch {
        // A missed tick retries. The thread on screen stays as it is.
      }
    };
    void pull();
    const timer = setInterval(() => void pull(), 2000);
    // Web can also hear the live stream. Native fetch has no streaming body,
    // so the interval above is what paints a reply there. Do not close this
    // on the first bubble — a second message must still land in order.
    const unsubscribe =
      Platform.OS === "web"
        ? core.subscribeMessages(account, liveRoomId, (event) => {
            if (event.message || event.reaction || event.type === "done" || event.type === "run" || event.type === "error") {
              void pull();
            }
            if (event.type === "error") {
              expectReply.current = false;
              setTyping(false);
              show(new Error(event.error ?? "The turn failed."));
            } else if (event.type === "notify" && event.notification) {
              void core
                .listNotifications(account)
                .then((pending) => setPendingCount(pending.length))
                .catch(() => {});
              setNote(`${event.notification.title}: ${event.notification.body}`.slice(0, 160));
            }
          })
        : () => {};
    return () => {
      stopped = true;
      clearInterval(timer);
      unsubscribe();
    };
  }, [liveRoomId, accountId]);

  /**
   * Loads per-chat context + usage for the header line. Best-effort: a failure
   * hides the line instead of blocking the chat.
   * Input: room id. Output: nothing. Sets the header line.
   */
  async function loadContextLine(roomId: string): Promise<void> {
    try {
      const info = await core.chatContext(accountId.trim(), roomId);
      setContextLine(formatContextLine(info));
    } catch {
      setContextLine(null);
    }
  }

  /**
   * Enters any room — direct or group — with the right header.
   * Why: one shared path so created, reopened, and direct rooms all show the
   * correct title (group title, never a disguised 1:1) plus member names.
   * Input: room record + roster. Output: nothing. Chat screen opens on it.
   */
  async function enterRoom(
    room: { id: string; kind: string; title: string; ownerAgentId: string },
    roster: RosterAgent[],
  ): Promise<void> {
    const id = accountId.trim();
    const owner = roster.find((row) => row.id === room.ownerAgentId);
    if (!owner) {
      return;
    }
    const [memberRows, history, taps] = await Promise.all([
      core.listMembers(id, room.id).catch(() => [{ agentId: owner.id }]),
      core.listMessages(id, room.id),
      core.listReactions(id, room.id),
    ]);
    const kind = room.kind === "group" ? ("group" as const) : ("direct" as const);
    const names = memberRows.map((member) => roster.find((row) => row.id === member.agentId)?.name ?? "Agent");
    const opened = {
      agent: owner,
      conversationId: room.id,
      kind,
      title: kind === "group" ? room.title : owner.name,
      subtitle: kind === "group" ? names.join(", ").slice(0, 60) : "",
      memberIds: memberRows.map((member) => member.agentId),
    };
    setAgents(roster);
    setConversationId(room.id);
    setLastChat(opened);
    setScreen({ name: "chat", ...opened });
    setContextLine(null);
    void loadContextLine(room.id);
    setMessages(toBubbles(history, taps, roster));
    setDraft("");
    setReplyTo(null);
    setAttachments([]);
    setAttachOpen(false);
    setNote("");
  }

  /**
   * Loads group rooms for the inbox section.
   * Why: groups previously vanished after creation — the inbox listed agents
   * only. Counts come from one members call per group (few groups per user).
   * Input: account id + roster (unused, kept for symmetry). Output: nothing.
   */
  async function loadGroups(id: string, roster: RosterAgent[]): Promise<void> {
    const rooms = await core.listConversations(id).catch(() => []);
    const groups = rooms.filter((room) => room.kind === "group");
    const withCounts = await Promise.all(
      groups.map(async (group) => {
        const members = await core.listMembers(id, group.id).catch(() => []);
        return {
          id: group.id,
          title: group.title,
          memberCount: members.length,
          members: members.map((member) => {
            const agent = roster.find((row) => row.id === member.agentId);
            return {
              id: member.agentId,
              markShape: agent?.markShape,
              markColor: agent?.markColor,
              avatarUrl: agent?.avatarUrl,
            };
          }),
        };
      }),
    );
    setGroups(withCounts);
  }

  /**
   * Opens a direct chat with one agent and subscribes to live turns.
   * Input: the agent from the roster.
   * Output: nothing. The conversation screen is shown and streams.
   */
  async function openAgent(agent: RosterAgent): Promise<void> {
    const id = accountId.trim();
    const rooms = await core.listConversations(id);
    const existing = rooms.find((room) => room.kind === "direct" && room.ownerAgentId === agent.id);
    const rows = await core.listAgents(id);
    const fresh = rows.find((row) => row.id === agent.id) ?? agent;
    setAgents(rows);
    if (existing) {
      await enterRoom(existing, rows);
      return;
    }
    const room = await core.openChat(id, agent);
    await enterRoom({ id: room.id, kind: "direct", title: fresh.name, ownerAgentId: fresh.id }, rows);
  }

  /**
   * Reopens a group from the inbox list.
   * Input: the group conversation id. Output: nothing. Chat opens on it.
   */
  async function openGroup(roomId: string): Promise<void> {
    const id = accountId.trim();
    const [rooms, rows] = await Promise.all([core.listConversations(id), core.listAgents(id)]);
    const room = rooms.find((row) => row.id === roomId);
    if (!room) {
      return;
    }
    setAgents(rows);
    await enterRoom(room, rows);
  }

  /**
   * Sends composer text and/or attachments via 202 background turn.
   * Why: POST now returns the saved user row synchronously, so the optimistic
   * bubble is swapped for the confirmed id instead of being wiped by the
   * safety refresh — a sent message can never vanish. Agent bubbles stream in
   * live via SSE; done/error ends typing with a final reconciling refresh.
   * Input: the open chat. Reads draft, attachments, reply target. Output: nothing.
   */
  async function send(conversationId: string): Promise<void> {
    const body = draft.trim();
    if ((!body && attachments.length === 0) || sending) {
      return;
    }
    const blocks: MessageBlock[] = [];
    if (body) {
      blocks.push({ kind: "text", markdown: body });
    }
    for (const attachment of attachments) {
      if (attachment.kind === "image") {
        blocks.push({ kind: "image", url: attachment.url, alt: attachment.name });
      } else {
        blocks.push({ kind: "file", url: attachment.url, name: attachment.name ?? "file", mime: attachment.mime ?? undefined });
      }
    }
    const fallback = body || (attachments.length === 1 && attachments[0]?.kind === "image" ? "[image]" : `[${attachments.length} attachments]`);
    const pendingAt = new Date().toISOString();
    const pendingId = `pending-${Date.now()}`;
    const pending: Bubble = {
      id: pendingId,
      author: "You",
      agentId: null,
      mine: true,
      body: fallback,
      sortAt: pendingAt,
      time: new Date(pendingAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }),
      blocks,
      replyTo: replyTo?.id ?? null,
      replyPreview: replyTo?.body.slice(0, 80) ?? null,
      reactions: [],
    };
    setSending(true);
    setTyping(true);
    setDraft("");
    setAttachments([]);
    const target = replyTo;
    setReplyTo(null);
    setAttachOpen(false);
    setNote("");
    setMessages((current) => [...current, pending]);
    // A failed POST must restore the composer so nothing the user wrote is lost.
    // Defensive id: an outdated core returns no message row — keep the pending
    // bubble instead of crashing it away (the old vanishing glitch).
    let confirmedId = pendingId;
    try {
      const saved = await core.sendMessage(accountId.trim(), conversationId, fallback, {
        blocks,
        replyTo: target?.id ?? null,
      });
      if (saved.message?.id) {
        confirmedId = saved.message.id;
        setMessages((current) => current.map((bubble) => (bubble.id === pendingId ? { ...bubble, id: confirmedId } : bubble)));
      }
    } catch (error) {
      setMessages((current) => current.filter((bubble) => bubble.id !== pendingId));
      setDraft(body);
      setTyping(false);
      setSending(false);
      throw error;
    }
    expectReply.current = true;
    setSending(false);
  }

  /**
   * Sends one explicit text as the open chat's next turn.
   * Why: poll widgets answer without touching the composer — draft text the
   * user is typing must survive a tap on Submit. Input: room id + answer
   * text. Output: nothing. The optimistic bubble confirms like a typed send.
   */
  async function sendText(conversationId: string, body: string): Promise<void> {
    const text = body.trim();
    if (!text || sending) {
      return;
    }
    const pendingAt = new Date().toISOString();
    const pendingId = `pending-${Date.now()}`;
    const pending: Bubble = {
      id: pendingId,
      author: "You",
      agentId: null,
      mine: true,
      body: text,
      sortAt: pendingAt,
      time: new Date(pendingAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }),
      blocks: [{ kind: "text", markdown: text }],
      replyTo: null,
      replyPreview: null,
      reactions: [],
    };
    setSending(true);
    setTyping(true);
    setNote("");
    setMessages((current) => [...current, pending]);
    let confirmedId = pendingId;
    try {
      const saved = await core.sendMessage(accountId.trim(), conversationId, text, {
        blocks: [{ kind: "text", markdown: text }],
        replyTo: null,
      });
      if (saved.message?.id) {
        confirmedId = saved.message.id;
        setMessages((current) => current.map((bubble) => (bubble.id === pendingId ? { ...bubble, id: confirmedId } : bubble)));
      }
    } catch (error) {
      setMessages((current) => current.filter((bubble) => bubble.id !== pendingId));
      setTyping(false);
      setSending(false);
      throw error;
    }
    expectReply.current = true;
    setSending(false);
  }

  /**
   * Saves one vault secret from a secret widget.
   * Why: the masked value must never enter chat — it posts straight to the
   * write-only vault. Input: env name + secret. Output: nothing. Throws
   * after noting so the widget keeps the typed value on failure.
   */
  async function saveVaultSecret(name: string, secret: string): Promise<void> {
    try {
      await core.saveSecret(accountId.trim(), { name, secret });
      setNote("Secret saved.");
      if (conversationId) {
        setTyping(true);
        expectReply.current = true;
        await core.wakeCue(accountId.trim(), conversationId, {
          cue: `Person saved secret ${name} to the vault. Continue using that env name — never ask them to paste it again.`,
        });
      }
    } catch (error) {
      show(error);
      throw error;
    }
  }

  /**
   * Records a question-widget pick without posting a user chat bubble.
   * Why: taps must stay on the card; waking the agent with a cue keeps the
   * thread clean (no "b" / "4" bubbles from option values).
   */
  async function answerQuestion(
    conversationId: string,
    messageId: string,
    pick: { value: string; label: string },
  ): Promise<void> {
    setTyping(true);
    expectReply.current = true;
    setNote("");
    setMessages((current) =>
      current.map((bubble) => {
        if (bubble.id !== messageId || !bubble.blocks) return bubble;
        return {
          ...bubble,
          blocks: bubble.blocks.map((block) =>
            block.kind === "widget" && block.widget === "question"
              ? { ...block, props: { ...block.props, selected: pick.value } }
              : block,
          ),
        };
      }),
    );
    await core.wakeCue(accountId.trim(), conversationId, {
      cue: `Person tapped your question and chose "${pick.label}" (value: ${pick.value}). Continue from that choice.`,
      messageId,
      selected: pick.value,
    });
  }

  const MAX_IMAGE_BYTES = 5_000_000;
  const MAX_FILE_BYTES = 2_000_000;

  /**
   * Picks one image from the library and stages it as an attachment.
   * Why: images travel as data URIs inside image blocks so the agent's vision
   * grounding receives pixels, not a phone-local path it cannot open.
   * Compresses to cap the row size. Input: none (uses picker UI). Output: nothing.
   */
  async function pickImage(): Promise<void> {
    setAttachOpen(false);
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setNote("Photo access is needed to attach images.");
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      base64: true,
      quality: 0.7,
    });
    if (picked.canceled || picked.assets.length === 0) {
      return;
    }
    const asset = picked.assets[0]!;
    if (!asset.base64) {
      setNote("That image could not be read. Try another.");
      return;
    }
    const bytes = Math.floor((asset.base64.length * 3) / 4);
    if (bytes > MAX_IMAGE_BYTES) {
      setNote("That image is too large (over 5MB). Try a smaller one.");
      return;
    }
    const mime = asset.mimeType ?? "image/jpeg";
    const url = `data:${mime};base64,${asset.base64}`;
    try {
      await core.upload(accountId.trim(), { url, name: asset.fileName ?? "image" });
    } catch (error) {
      show(error);
      return;
    }
    setAttachments((current) => [
      ...current,
      { id: `att-${Date.now()}`, kind: "image", url, name: asset.fileName ?? "image", mime },
    ]);
  }

  /**
   * Picks one file and stages it as an attachment.
   * Why: small working files (text, csv, pdf) embed as data URIs in file
   * blocks so the agent can read them on its Linux. Hard-capped at 2MB to
   * keep rows and prompts bounded; larger files need object storage (later seam).
   * Input: none (uses picker UI). Output: nothing.
   */
  async function pickFile(): Promise<void> {
    setAttachOpen(false);
    const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (picked.canceled || picked.assets.length === 0) {
      return;
    }
    const asset = picked.assets[0]!;
    if (asset.size != null && asset.size > MAX_FILE_BYTES) {
      setNote("That file is too large (over 2MB).");
      return;
    }
    let base64: string;
    try {
      base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: "base64" });
    } catch {
      setNote("That file could not be read.");
      return;
    }
    if (Math.floor((base64.length * 3) / 4) > MAX_FILE_BYTES) {
      setNote("That file is too large (over 2MB).");
      return;
    }
    const mime = asset.mimeType ?? "application/octet-stream";
    const url = `data:${mime};base64,${base64}`;
    try {
      await core.upload(accountId.trim(), { url, name: asset.name });
    } catch (error) {
      show(error);
      return;
    }
    setAttachments((current) => [
      ...current,
      { id: `att-${Date.now()}`, kind: "file", url, name: asset.name, mime },
    ]);
  }

  /**
   * Toggles one emoji tapback on a bubble and refreshes the row.
   * Why: reactions are idempotent per (message, owner, emoji) server-side.
   */
  async function toggleReaction(conversationId: string, bubble: Bubble, emoji: string): Promise<void> {
    await core.react(accountId.trim(), conversationId, bubble.id, emoji);
    await refreshThread(conversationId, agents);
  }

  async function persistAutoReview(value: boolean): Promise<void> {
    setAutoReview(value);
    await core.setAutoReview(accountId.trim(), value);
  }

  /**
   * Loads pending proposals and Auto-review rows, replacing the lists after each decision.
   * Input: optional proposal id and whether the person accepts it. Omit both to only refresh.
   * Output: nothing. The list no longer includes a proposal that was just decided.
   */
  async function refreshProposals(proposalId?: string, accept?: boolean): Promise<void> {
    const next = proposalId
      ? await (accept ? core.approve(accountId.trim(), proposalId) : core.reject(accountId.trim(), proposalId))
      : await core.listProposals(accountId.trim());
    setProposals(next);
    setToolApprovals(await core.listToolApprovals(accountId.trim()).catch(() => []));
    setScreen({ name: "approvals" });
    setMenu(null);
    setNote("");
  }

  async function decideToolRow(approvalId: string, accept: boolean): Promise<void> {
    const status = accept ? "approved" : "denied";
    setMessages((current) =>
      current.map((bubble) => {
        if (!bubble.blocks) return bubble;
        const blocks = bubble.blocks.map((block) => {
          if (block.kind !== "widget" || block.widget !== "approval") return block;
          const props = block.props && typeof block.props === "object" ? block.props : {};
          if ((props as { approvalId?: string }).approvalId !== approvalId) return block;
          return { ...block, props: { ...props, status } };
        });
        return { ...bubble, blocks };
      }),
    );
    const next = accept
      ? await core.approveTool(accountId.trim(), approvalId)
      : await core.denyTool(accountId.trim(), approvalId);
    setToolApprovals(next);
  }

  /**
   * Opens the agent profile editor for one agent.
   * Why: one shared path so chat-name taps land on the same form the
   * desktop More menu used to open. Input: the agent. Output: nothing.
   * The profile screen opens on it.
   */
  function openProfile(agent: RosterAgent, fromGroup = false): void {
    void core
      .listProviders(accountId.trim())
      .then(setProviders)
      .catch(show);
    void refreshRoutines(agent.id).catch(show);
    setProfile(agent);
    if (screen.name === "chat" && screen.kind === "direct" && screen.agent.id === agent.id) {
      setProfileFeed(messages.map((row) => ({ ...row, conversationId: screen.conversationId })));
    } else {
      setProfileFeed([]);
    }
    setScreen({ name: "profile", agent, fromGroup });
    void loadDirectFeed(agent.id).then(setProfileFeed).catch(show);
  }

  /** Opens the room page for a group instead of the owner's profile. */
  async function openGroupInfo(): Promise<void> {
    if (screen.name !== "chat" || screen.kind !== "group") return;
    const conversationId = screen.conversationId;
    const memberIds = screen.memberIds;
    setGroupFeed(messages.map((row) => ({ ...row, conversationId })));
    setScreen({
      name: "group",
      conversationId,
      title: screen.title,
      memberIds,
      owner: screen.agent,
    });
    const history = await core.listMessages(accountId.trim(), conversationId).catch(() => null);
    if (!Array.isArray(history)) return;
    setGroupFeed(toBubbles(history, [], agents).map((row) => ({ ...row, conversationId })));
  }

  /** Loads one agent's private thread for the profile Links, Media, and Files tabs. */
  async function loadDirectFeed(agentId: string): Promise<(Bubble & { conversationId?: string })[]> {
    const id = accountId.trim();
    const rooms = await core.listConversations(id).catch(() => []);
    const direct = rooms.find((room) => room.kind === "direct" && room.ownerAgentId === agentId);
    if (!direct) return [];
    const history = await core.listMessages(id, direct.id).catch(() => null);
    if (!Array.isArray(history)) return [];
    return toBubbles(history, [], agents).map((row) => ({ ...row, conversationId: direct.id }));
  }

  /**
   * Saves the open profile and updates that agent in the roster.
   * Input: an optional draft (the notifications toggle saves immediately,
   * before state settles). Omit it to save the profile on screen.
   * Output: nothing. The roster shows the saved name, label, and flags.
   */
  /** Pins or hides one roster agent without opening the profile. */
  async function setRosterFlag(agent: RosterAgent, patch: { pinned?: boolean; hidden?: boolean }): Promise<void> {
    const saved = await core.saveProfile(accountId.trim(), agent.id, patch);
    setAgents((rows) => rows.map((row) => (row.id === agent.id ? { ...row, ...saved, ...patch } : row)));
  }

  async function saveProfile(draft?: RosterAgent): Promise<void> {
    const current = draft ?? profile;
    if (!current) {
      return;
    }
    const saved = await core.saveProfile(accountId.trim(), current.id, current);
    setProfile(saved);
    setAgents((rows) => rows.map((agent) => (agent.id === saved.id ? saved : agent)));
    setLastChat((currentChat) =>
      currentChat && currentChat.agent.id === saved.id
        ? { ...currentChat, agent: saved, title: currentChat.kind === "group" ? currentChat.title : saved.name }
        : currentChat,
    );
    setNote("Saved.");
  }

  /**
   * Reloads one agent's routines into the bot info page.
   * Input: the agent id. Output: nothing. The routines group re-renders.
   */
  async function refreshRoutines(agentId: string): Promise<void> {
    setRoutines(await core.listRoutines(accountId.trim(), agentId));
  }

  /**
   * Picks one photo from the library and saves it as the bot's avatar.
   * Why: tapping the big mark on the bot info page replaces the drawn mark
   * with a photo. Images travel as data URIs, validated by the core upload.
   * Input: none (uses picker UI). Output: nothing. The draft shows the photo.
   */
  async function pickAvatar(): Promise<void> {
    if (!profile) {
      return;
    }
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setNote("Photo access is needed for the bot photo.");
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      base64: true,
      quality: 0.7,
    });
    if (picked.canceled || picked.assets.length === 0) {
      return;
    }
    const asset = picked.assets[0]!;
    if (!asset.base64) {
      setNote("That image could not be read. Try another.");
      return;
    }
    if (Math.floor((asset.base64.length * 3) / 4) > MAX_IMAGE_BYTES) {
      setNote("That image is too large (over 5MB). Try a smaller one.");
      return;
    }
    const mime = asset.mimeType ?? "image/jpeg";
    const url = `data:${mime};base64,${asset.base64}`;
    try {
      await core.upload(accountId.trim(), { url, name: asset.fileName ?? "avatar" });
    } catch (error) {
      show(error);
      return;
    }
    await saveProfile({ ...profile, avatarUrl: url });
  }

  /**
   * Pauses or resumes one routine and reloads the group.
   * Input: the routine and the wanted paused flag. Output: nothing.
   */
  async function pauseRoutine(routine: Routine, paused: boolean): Promise<void> {
    if (!profile) {
      return;
    }
    await core.updateRoutine(accountId.trim(), profile.id, routine.id, { paused });
    await refreshRoutines(profile.id);
  }

  /**
   * Saves one account-scoped provider credential and refreshes the safe metadata.
   * Input: provider name, a new secret or blank to retain it, and an optional local URL.
   * Output: nothing. The phone never receives the saved secret.
   */
  async function saveProvider(
    provider: ProviderSetting["provider"],
    secret: string,
    baseUrl: string | null,
  ): Promise<void> {
    await core.saveProvider(accountId, { provider, secret, baseUrl });
    setProviders(await core.listProviders(accountId));
    setNote("Provider saved.");
  }

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar barStyle="light-content" />
      {screen.name === "inbox" ? (
        <InboxScreen
          agents={agents}
          groups={groups}
          pendingCount={pendingCount}
          onOpenGroup={(id) => void openGroup(id).catch(show)}
          onAccount={() => {
            if (!account) {
              setMenu("signup");
              return;
            }
            void core
              .listProviders(account.id)
              .then((rows) => {
                setProviders(rows);
                setMenu("menu");
              })
              .catch(show);
          }}
          onNew={() => {
            if (!accountId) {
              setAfterSignup(true);
              setMenu("signup");
              return;
            }
            setCreating(true);
          }}
          onOpen={(agent) => void openAgent(agent).catch(show)}
          onPin={(agent) => void setRosterFlag(agent, { pinned: !agent.pinned }).catch(show)}
          onHide={(agent) => void setRosterFlag(agent, { hidden: true }).catch(show)}
          menu={
            menu ? (
              <MenuSheet
                page={menu}
                account={account}
                accounts={accounts}
                notifications={notifications}
                autoReview={autoReview}
                autoTimeZone={autoTimeZone}
                timeZone={timeZone}
                providers={providers}
                onClose={() => setMenu(null)}
                onPage={setMenu}
                onNotifications={setNotifications}
                onAutoReview={(value) => void persistAutoReview(value).catch(show)}
                onAutoTimeZone={setAutoTimeZone}
                onApprovals={() => void refreshProposals().catch(show)}
                onComputer={() => {
                  const agent = agents.find((row) => row.linuxProfile) ?? agents[0];
                  if (agent) {
                    setMenu(null);
                    setScreen({ name: "desktop", agent });
                  }
                }}
                onSaveProvider={(provider, secret, baseUrl) =>
                  void saveProvider(provider, secret, baseUrl).catch(show)
                }
                onGoogle={() => void signInWithGoogle().catch(show)}
                onSwitch={(id) => void switchAccount(id).catch(show)}
                onSignOut={() => {
                  void authClient.signOut().catch(show);
                  setAccountId("");
                  setAgents([]);
                  setMenu("signup");
                }}
                onDelete={(id) => {
                  setAccounts((rows) => rows.filter((row) => row.id !== id));
                  if (accountId === id) {
                    setAccountId("");
                    setAgents([]);
                    setMenu("signup");
                  }
                }}
              />
            ) : null
          }
        />
      ) : null}
      {screen.name === "chat" ? (
        <ChatScreen
          agent={screen.agent}
          conversationId={screen.conversationId}
          title={screen.title}
          subtitle={screen.subtitle}
          contextLine={contextLine}
          members={
            screen.kind === "group" ? agents.filter((row) => screen.memberIds.includes(row.id)) : []
          }
          messages={messages}
          draft={draft}
          sending={sending}
          typing={typing}
          error={note}
          replyTo={replyTo}
          attachments={attachments}
          attachOpen={attachOpen}
          onDraft={setDraft}
          onSend={() => void send(screen.conversationId).catch(show).finally(() => setSending(false))}
          onAttach={() => setAttachOpen((open) => !open)}
          onCloseAttach={() => setAttachOpen(false)}
          onPickImage={() => void pickImage().catch(show)}
          onPickFile={() => void pickFile().catch(show)}
          onRemoveAttachment={(id) => setAttachments((current) => current.filter((attachment) => attachment.id !== id))}
          onMention={() => setDraft(core.mention(draft, screen.agent.name))}
          onReply={setReplyTo}
          onClearReply={() => setReplyTo(null)}
          onPollSubmit={(text) => void sendText(screen.conversationId, text).catch(show)}
          onQuestionPick={(messageId, pick) =>
            void answerQuestion(screen.conversationId, messageId, pick).catch(show)
          }
          onSecretSubmit={(name, secret) => saveVaultSecret(name, secret)}
          onReact={(bubble, emoji) => void toggleReaction(screen.conversationId, bubble, emoji).catch(show)}
          onApprove={(approvalId) => {
            if (approvalId) void decideToolRow(approvalId, true).catch(show);
            else void refreshProposals().catch(show);
          }}
          onDeny={(approvalId) => {
            if (approvalId) void decideToolRow(approvalId, false).catch(show);
            else void refreshProposals().catch(show);
          }}
          onFetchBlob={(messageId, index) =>
            core.blob(accountId.trim(), screen.conversationId, messageId, index)
          }
          onBack={() => setScreen({ name: "inbox" })}
          onDesktop={() => setScreen({ name: "desktop", agent: screen.agent })}
          onAgentMenu={() => {
            if (screen.kind === "group") void openGroupInfo().catch(show);
            else openProfile(screen.agent);
          }}
        />
      ) : null}
      {screen.name === "desktop" ? (
        <DesktopScreen
          accountId={accountId.trim()}
          agent={screen.agent}
          onBack={() =>
            lastChat && conversationId
              ? setScreen({ name: "chat", ...lastChat })
              : setScreen({ name: "inbox" })
          }
          onApprovals={() => void refreshProposals().catch(show)}
          onError={show}
        />
      ) : null}
      {screen.name === "profile" && profile ? (
        <BotInfoScreen
          profile={profile}
          providers={providers}
          routines={routines}
          onChange={setProfile}
          onSave={() => void saveProfile().catch(show)}
          onSaveNotify={(draft) => void saveProfile(draft).catch(show)}
          onBack={() => {
            if (screen.fromGroup && lastChat?.kind === "group") {
              setScreen({
                name: "group",
                conversationId: lastChat.conversationId,
                title: lastChat.title,
                memberIds: lastChat.memberIds,
                owner: lastChat.agent,
              });
              return;
            }
            setScreen(lastChat && conversationId ? { name: "chat", ...lastChat } : { name: "inbox" });
          }}
          onApprovals={() => void refreshProposals().catch(show)}
          onPickAvatar={() => void pickAvatar().catch(show)}
          onPauseRoutine={(routine, paused) => void pauseRoutine(routine, paused).catch(show)}
          onLoadRoutineRuns={(routineId) =>
            core.listRoutineRuns(accountId.trim(), profile.id, routineId)
          }
          messages={profileFeed}
          onFetchBlob={(roomId, messageId, index) => core.blob(accountId.trim(), roomId, messageId, index)}
        />
      ) : null}
      {screen.name === "group" ? (
        <GroupInfoScreen
          title={screen.title}
          members={screen.memberIds
            .map((id) => agents.find((agent) => agent.id === id))
            .filter((agent): agent is RosterAgent => Boolean(agent))}
          messages={groupFeed}
          onBack={() => setScreen(lastChat ? { name: "chat", ...lastChat } : { name: "inbox" })}
          onOpenMember={(member) => void openAgent(member).catch(show)}
          onFetchBlob={(roomId, messageId, index) => core.blob(accountId.trim(), roomId, messageId, index)}
        />
      ) : null}
      {screen.name === "approvals" ? (
        <ApprovalsScreen
          proposals={proposals}
          toolApprovals={toolApprovals}
          onApprove={(id) => void refreshProposals(id, true).catch(show)}
          onReject={(id) => void refreshProposals(id, false).catch(show)}
          onApproveTool={(id) => void decideToolRow(id, true).catch(show)}
          onDenyTool={(id) => void decideToolRow(id, false).catch(show)}
          onBack={() => setScreen({ name: "inbox" })}
        />
      ) : null}
      {screen.name === "inbox" && note ? <Text style={styles.note}>{note}</Text> : null}
      {screen.name === "profile" && note ? <Text style={styles.note}>{note}</Text> : null}
      <NewRoomSheet
        open={creating}
        agents={agents}
        providers={providers}
        onClose={() => setCreating(false)}
        onCreateChat={(name, role, jobDescription, provider, modelId) =>
          void createChat(name, role, jobDescription, provider, modelId).catch(show)
        }
        onCreateGroup={(title, agentIds) => void createGroup(title, agentIds).catch(show)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  note: { color: colors.danger, position: "absolute", left: 20, right: 20, bottom: 24, fontSize: 14 },
});
