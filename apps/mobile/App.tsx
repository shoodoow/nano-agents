import { useCallback, useEffect, useState } from "react";
import { Platform, SafeAreaView, StatusBar, StyleSheet, Text } from "react-native";
import {
  configureAuthCookie,
  createCore,
  type Proposal,
  type ProviderSetting,
  type RosterAgent,
} from "./src/api";
import { authClient } from "./src/auth";
import { MenuSheet, type MenuPage, type SignedAccount } from "./src/account/MenuSheet";
import { ApprovalsScreen } from "./src/approvals/ApprovalsScreen";
import { ChatScreen, type Bubble } from "./src/chat/ChatScreen";
import { DesktopScreen } from "./src/desktop/DesktopScreen";
import { InboxScreen } from "./src/inbox/InboxScreen";
import { NewRoomSheet } from "./src/inbox/NewRoomSheet";
import { ProfileScreen } from "./src/profile/ProfileScreen";
import { colors } from "./src/theme/tokens";

configureAuthCookie(authClient.getCookie);
const core = createCore();

/**
 * Turns saved rows into chat bubbles.
 * Input: the message rows and the account roster.
 * Output: bubbles with the speaker name and a clock time.
 */
function toBubbles(
  rows: { id: string; agentId: string | null; body: string; createdAt: string }[],
  roster: RosterAgent[],
): Bubble[] {
  return rows.map((row) => ({
    id: row.id,
    author: row.agentId ? (roster.find((agent) => agent.id === row.agentId)?.name ?? "Agent") : "You",
    body: row.body,
    time: new Date(row.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }),
  }));
}

type Screen =
  | { name: "inbox" }
  | { name: "chat"; agent: RosterAgent; conversationId: string }
  | { name: "desktop"; agent: RosterAgent }
  | { name: "profile"; agent: RosterAgent }
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
  const [note, setNote] = useState("");
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [profile, setProfile] = useState<RosterAgent | null>(null);
  const [conversationId, setConversationId] = useState("");
  const [notifications, setNotifications] = useState(true);
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
    const [roster, configured] = await Promise.all([
      core.listAgents(accountIdFromSession),
      core.listProviders(accountIdFromSession),
    ]);
    setAgents(roster);
    setProviders(configured);
    setScreen({ name: "inbox" });
    setMenu(null);
    setNote("");
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

  /**
   * Loads the roster for one signed-in account.
   * Input: the account id chosen in the switcher.
   * Output: nothing. The inbox shows that account's agents.
   */
  async function switchAccount(id: string): Promise<void> {
    setAccountId(id);
    setAgents(await core.listAgents(id));
    setProviders(await core.listProviders(id));
    setScreen({ name: "inbox" });
    setMenu("menu");
    setNote("");
  }

  /**
   * Hires an agent and opens a direct chat on the signed-in account.
   * Input: the agent name and description from the new-room sheet.
   * Output: nothing. The chat screen opens for that agent.
   */
  async function createChat(
    name: string,
    description: string,
    provider: ProviderSetting["provider"],
    modelId: string,
  ): Promise<void> {
    const hired = await core.hireAgent(accountId, { name, description, provider, modelId });
    const room = await core.openChat(accountId, hired);
    const rows = await core.listAgents(accountId);
    const fresh = rows.find((row) => row.id === hired.id) ?? hired;
    setAgents(rows);
    setConversationId(room.id);
    setScreen({ name: "chat", agent: fresh, conversationId: room.id });
    setMessages([]);
    setDraft("");
    setCreating(false);
    setNote("");
  }

  /**
   * Opens a group for the chosen agents on the signed-in account.
   * Input: the group title and the member ids.
   * Output: nothing. The chat screen opens on that group.
   */
  async function createGroup(title: string, agentIds: string[]): Promise<void> {
    const room = await core.createGroup(accountId, title, agentIds);
    const rows = await core.listAgents(accountId);
    const owner = rows.find((row) => row.id === agentIds[0]);
    setAgents(rows);
    if (!owner) {
      setCreating(false);
      return;
    }
    setConversationId(room.id);
    setScreen({ name: "chat", agent: owner, conversationId: room.id });
    setMessages([]);
    setDraft("");
    setCreating(false);
    setNote("");
  }

  /**
   * Opens a direct chat with one agent.
   * Input: the agent from the roster.
   * Output: nothing. The conversation screen is shown.
   */
  async function openAgent(agent: RosterAgent): Promise<void> {
    const id = accountId.trim();
    const rooms = await core.listConversations(id);
    const existing = rooms.find((room) => room.kind === "direct" && room.ownerAgentId === agent.id);
    const room = existing ?? (await core.openChat(id, agent));
    const rows = await core.listAgents(id);
    const fresh = rows.find((row) => row.id === agent.id) ?? agent;
    const history = await core.listMessages(id, room.id);
    setAgents(rows);
    setConversationId(room.id);
    setScreen({ name: "chat", agent: fresh, conversationId: room.id });
    setMessages(toBubbles(history, rows));
    setDraft("");
    setNote("");
  }

  /**
   * Sends the composer text to the core and appends the replies.
   * Input: the open chat. It reads the draft, which may contain an @mention.
   * Output: nothing. The thread shows the message and the agent's reply.
   */
  async function send(conversationId: string): Promise<void> {
    const body = draft.trim();
    if (!body || sending) {
      return;
    }
    const pending: Bubble = {
      id: `pending-${Date.now()}`,
      author: "You",
      body,
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }),
    };
    setSending(true);
    setDraft("");
    setNote("");
    setMessages((current) => [...current, pending]);
    await core.sendMessage(accountId.trim(), conversationId, body);
    const history = await core.listMessages(accountId.trim(), conversationId);
    setMessages(toBubbles(history, agents));
    setSending(false);
  }

  /**
   * Loads pending proposals and replaces the list after each decision.
   * Input: the proposal id and whether the person accepts it. Omit both to only refresh.
   * Output: nothing. The list no longer includes a proposal that was just decided.
   */
  async function refreshProposals(proposalId?: string, accept?: boolean): Promise<void> {
    const next = proposalId
      ? await (accept ? core.approve(accountId.trim(), proposalId) : core.reject(accountId.trim(), proposalId))
      : await core.listProposals(accountId.trim());
    setProposals(next);
    setScreen({ name: "approvals" });
    setMenu(null);
    setNote("");
  }

  /**
   * Saves the open profile and updates that agent in the roster.
   * Input: none. It reads the profile fields on screen.
   * Output: nothing. The roster shows the saved name, label, and flags.
   */
  async function saveProfile(): Promise<void> {
    if (!profile) {
      return;
    }
    const saved = await core.saveProfile(accountId.trim(), profile.id, profile);
    setProfile(saved);
    setAgents((rows) => rows.map((agent) => (agent.id === saved.id ? saved : agent)));
    setNote("Saved.");
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
                onAutoReview={setAutoReview}
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
          messages={messages}
          draft={draft}
          sending={sending}
          error={note}
          onDraft={setDraft}
          onSend={() => void send(screen.conversationId).catch(show).finally(() => setSending(false))}
          onMention={() => setDraft(core.mention(draft, screen.agent.name))}
          onBack={() => setScreen({ name: "inbox" })}
          onDesktop={() => setScreen({ name: "desktop", agent: screen.agent })}
        />
      ) : null}
      {screen.name === "desktop" ? (
        <DesktopScreen
          accountId={accountId.trim()}
          agent={screen.agent}
          onBack={() =>
            conversationId
              ? setScreen({ name: "chat", agent: screen.agent, conversationId })
              : setScreen({ name: "inbox" })
          }
          onProfile={() => {
            setProfile(screen.agent);
            setScreen({ name: "profile", agent: screen.agent });
          }}
          onApprovals={() => void refreshProposals().catch(show)}
          onError={show}
        />
      ) : null}
      {screen.name === "profile" && profile ? (
        <ProfileScreen
          profile={profile}
          onChange={setProfile}
          onSave={() => void saveProfile().catch(show)}
          onBack={() => setScreen({ name: "inbox" })}
        />
      ) : null}
      {screen.name === "approvals" ? (
        <ApprovalsScreen
          proposals={proposals}
          onApprove={(id) => void refreshProposals(id, true).catch(show)}
          onReject={(id) => void refreshProposals(id, false).catch(show)}
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
        onCreateChat={(name, description, provider, modelId) =>
          void createChat(name, description, provider, modelId).catch(show)
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
