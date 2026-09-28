import { useState } from "react";
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { createCore, type Proposal, type RosterAgent } from "./src/api";

const core = createCore();

type Chat = { agent: RosterAgent; conversationId: string };

/**
 * Shows the roster, a chat, approvals, and an agent profile.
 * Input: none. The core URL comes from EXPO_PUBLIC_CORE_URL.
 * Output: the phone screens for those actions.
 */
export default function App() {
  const [accountId, setAccountId] = useState("");
  const [agents, setAgents] = useState<RosterAgent[]>([]);
  const [chat, setChat] = useState<Chat | null>(null);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState("");
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [profile, setProfile] = useState<RosterAgent | null>(null);

  /**
   * Shows a request error on the screen.
   * Input: the thrown value.
   * Output: nothing. The note becomes the error message.
   */
  function show(error: unknown): void {
    setNote(error instanceof Error ? error.message : "The request failed.");
  }

  /**
   * Loads the roster for the typed account.
   * Input: none. It reads the account id from the field.
   * Output: nothing. The list becomes that account's agents.
   */
  async function loadRoster(): Promise<void> {
    const rows = await core.listAgents(accountId.trim());
    setAgents(rows);
    setChat(null);
    setProposals(null);
    setProfile(null);
    setNote("");
  }

  /**
   * Opens a direct chat with one agent.
   * Input: the agent from the roster.
   * Output: nothing. The composer is shown for that conversation.
   */
  async function openAgent(agent: RosterAgent): Promise<void> {
    const room = await core.openChat(accountId.trim(), agent);
    setChat({ agent, conversationId: room.id });
    setProposals(null);
    setProfile(null);
    setDraft("");
    setNote("");
  }

  /**
   * Sends the composer text to the core.
   * Input: none. It reads the draft, which may contain an @mention.
   * Output: nothing. The draft clears after the core accepts the message.
   */
  async function send(): Promise<void> {
    if (!chat) {
      return;
    }
    await core.sendMessage(accountId.trim(), chat.conversationId, draft);
    setDraft("");
    setNote("Sent.");
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
    setChat(null);
    setProfile(null);
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

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Roster</Text>
      <TextInput
        value={accountId}
        onChangeText={setAccountId}
        placeholder="Account id"
        autoCapitalize="none"
        style={styles.input}
      />
      <Pressable onPress={() => void loadRoster().catch(show)} style={styles.button}>
        <Text style={styles.buttonText}>Load roster</Text>
      </Pressable>
      <Pressable onPress={() => void refreshProposals().catch(show)} style={styles.button}>
        <Text style={styles.buttonText}>Approvals</Text>
      </Pressable>
      {agents.map((agent) => (
        <View key={agent.id}>
          <Pressable onPress={() => void openAgent(agent).catch(show)}>
            <Text style={styles.agent}>
              {agent.name} · {agent.label}
            </Text>
          </Pressable>
          <Pressable onPress={() => setProfile(agent)}>
            <Text>Edit profile</Text>
          </Pressable>
        </View>
      ))}
      {chat ? (
        <View>
          <Text style={styles.title}>Chat with {chat.agent.name}</Text>
          <TextInput value={draft} onChangeText={setDraft} placeholder="Message" style={styles.input} />
          <Pressable onPress={() => setDraft(core.mention(draft, chat.agent.name))} style={styles.button}>
            <Text style={styles.buttonText}>Mention @{chat.agent.name}</Text>
          </Pressable>
          <Pressable onPress={() => void send().catch(show)} style={styles.button}>
            <Text style={styles.buttonText}>Send</Text>
          </Pressable>
        </View>
      ) : null}
      {proposals ? (
        <View>
          <Text style={styles.title}>Approvals</Text>
          {proposals.length === 0 ? <Text>No pending proposals.</Text> : null}
          {proposals.map((proposal) => (
            <View key={proposal.id}>
              <Text>
                {proposal.kind}: {proposal.body}
              </Text>
              <Pressable onPress={() => void refreshProposals(proposal.id, true).catch(show)} style={styles.button}>
                <Text style={styles.buttonText}>Approve</Text>
              </Pressable>
              <Pressable onPress={() => void refreshProposals(proposal.id, false).catch(show)} style={styles.button}>
                <Text style={styles.buttonText}>Reject</Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      {profile ? (
        <View>
          <Text style={styles.title}>Profile</Text>
          <TextInput value={profile.name} onChangeText={(name) => setProfile({ ...profile, name })} style={styles.input} />
          <TextInput value={profile.label} onChangeText={(label) => setProfile({ ...profile, label })} style={styles.input} />
          <TextInput
            value={profile.description}
            onChangeText={(description) => setProfile({ ...profile, description })}
            style={styles.input}
          />
          <Flag label="Pin" value={profile.pinned} onChange={(pinned) => setProfile({ ...profile, pinned })} />
          <Flag label="Hide" value={profile.hidden} onChange={(hidden) => setProfile({ ...profile, hidden })} />
          <Flag label="Notify" value={profile.notify} onChange={(notify) => setProfile({ ...profile, notify })} />
          <Pressable onPress={() => void saveProfile().catch(show)} style={styles.button}>
            <Text style={styles.buttonText}>Save profile</Text>
          </Pressable>
        </View>
      ) : null}
      {note ? <Text>{note}</Text> : null}
    </View>
  );
}

/**
 * Renders one profile switch.
 * Input: the label, the current value, and a change callback.
 * Output: a labeled switch.
 */
function Flag({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <View style={styles.flag}>
      <Text>{label}</Text>
      <Switch value={value} onValueChange={onChange} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 24, gap: 12 },
  title: { fontSize: 22, fontWeight: "600" },
  input: { borderWidth: 1, borderColor: "#ccc", padding: 10, borderRadius: 8 },
  button: { backgroundColor: "#111", padding: 12, borderRadius: 8 },
  buttonText: { color: "#fff" },
  agent: { fontSize: 18, paddingVertical: 8 },
  flag: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
});
