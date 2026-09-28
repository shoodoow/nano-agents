import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { createCore, type RosterAgent } from "./src/api";

const core = createCore();

type Chat = { agent: RosterAgent; conversationId: string };

/**
 * Shows the roster and a chat.
 * Input: none. The core URL comes from EXPO_PUBLIC_CORE_URL.
 * Output: the phone screen for listing agents and sending a mentioned message.
 */
export default function App() {
  const [accountId, setAccountId] = useState("");
  const [agents, setAgents] = useState<RosterAgent[]>([]);
  const [chat, setChat] = useState<Chat | null>(null);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState("");

  /**
   * Loads the roster for the typed account.
   * Input: none. It reads the account id from the field.
   * Output: nothing. The list becomes that account's agents.
   */
  async function loadRoster(): Promise<void> {
    const rows = await core.listAgents(accountId.trim());
    setAgents(rows);
    setChat(null);
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
      <Pressable onPress={() => void loadRoster().catch((error: unknown) => setNote(message(error)))} style={styles.button}>
        <Text style={styles.buttonText}>Load roster</Text>
      </Pressable>
      {agents.map((agent) => (
        <Pressable key={agent.id} onPress={() => void openAgent(agent).catch((error: unknown) => setNote(message(error)))}>
          <Text style={styles.agent}>
            {agent.name} · {agent.label}
          </Text>
        </Pressable>
      ))}
      {chat ? (
        <View>
          <Text style={styles.title}>Chat with {chat.agent.name}</Text>
          <TextInput value={draft} onChangeText={setDraft} placeholder="Message" style={styles.input} />
          <Pressable onPress={() => setDraft(core.mention(draft, chat.agent.name))} style={styles.button}>
            <Text style={styles.buttonText}>Mention @{chat.agent.name}</Text>
          </Pressable>
          <Pressable onPress={() => void send().catch((error: unknown) => setNote(message(error)))} style={styles.button}>
            <Text style={styles.buttonText}>Send</Text>
          </Pressable>
        </View>
      ) : null}
      {note ? <Text>{note}</Text> : null}
    </View>
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed.";
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 24, gap: 12 },
  title: { fontSize: 22, fontWeight: "600" },
  input: { borderWidth: 1, borderColor: "#ccc", padding: 10, borderRadius: 8 },
  button: { backgroundColor: "#111", padding: 12, borderRadius: 8 },
  buttonText: { color: "#fff" },
  agent: { fontSize: 18, paddingVertical: 8 },
});
