import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { ProviderSetting, RosterAgent } from "../api";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { useResolvedScheme } from "../theme/appearance";
import { IconCheck } from "../ui/icons";
import { PrimaryButton } from "../ui/PrimaryButton";
import { pressableStyle } from "../ui/pressableStyles";

/**
 * Creates a direct chat or a group on the signed-in account.
 * Why: hiring needs role + job up front (personality optional) so the agent
 * starts sharp instead of a vague blob.
 * Input: the account's agents and the create handlers.
 * Output: the new-room form. The account id stays outside this form.
 */
export function NewRoomSheet({
  agents,
  providers,
  onCreateChat,
  onCreateGroup,
}: {
  agents: RosterAgent[];
  providers: ProviderSetting[];
  onCreateChat: (
    name: string,
    role: string,
    jobDescription: string,
    provider: ProviderSetting["provider"],
    modelId: string,
  ) => void;
  onCreateGroup: (title: string, agentIds: string[]) => void;
}) {
  const [kind, setKind] = useState<"chat" | "group">("chat");
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [job, setJob] = useState("");
  const [provider, setProvider] = useState<ProviderSetting["provider"]>("openai");
  const [modelId, setModelId] = useState("gpt-5");
  const [title, setTitle] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const configured = providers.filter((row) => row.configured);
  const chatReady =
    name.trim().length > 0 &&
    role.trim().length > 0 &&
    job.trim().length > 0 &&
    modelId.trim().length > 0 &&
    configured.some((row) => row.provider === provider);
  const groupReady = title.trim().length > 0 && picked.length >= 2;
  useResolvedScheme();

  /**
   * Toggles one agent in the group.
   * Input: the agent id.
   * Output: nothing. The picked list gains or loses that id.
   */
  function toggle(id: string): void {
    setPicked((current) => (current.includes(id) ? current.filter((row) => row !== id) : [...current, id]));
  }

  return (
      <ScrollView
        style={process.env.EXPO_OS === "ios" ? { backgroundColor: colors.sheet } : { flex: 1, backgroundColor: colors.sheet }}
        nestedScrollEnabled
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
          <View style={styles.kinds}>
            <Pressable
              accessibilityRole="button"
              onPress={() => setKind("chat")}
              style={({ pressed }) => pressableStyle([styles.kind, kind === "chat" && styles.kindOn], { pressed })}
            >
              <Text style={[styles.kindText, kind === "chat" && styles.kindTextOn]}>Chat</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => setKind("group")}
              style={({ pressed }) => pressableStyle([styles.kind, kind === "group" && styles.kindOn], { pressed })}
            >
              <Text style={[styles.kindText, kind === "group" && styles.kindTextOn]}>Group</Text>
            </Pressable>
          </View>
          {kind === "chat" ? (
            <>
              <TextInput value={name} onChangeText={setName} placeholder="Agent name" placeholderTextColor={colors.muted} keyboardAppearance="dark" style={styles.input} />
              <TextInput
                value={role}
                onChangeText={setRole}
                placeholder="Role (e.g. Social manager)"
                placeholderTextColor={colors.muted}
                keyboardAppearance="dark"
                style={styles.input}
              />
              <TextInput
                value={job}
                onChangeText={setJob}
                placeholder="What they do"
                placeholderTextColor={colors.muted}
                keyboardAppearance="dark"
                style={styles.input}
              />
              <Text style={styles.hint}>Provider</Text>
              <View style={styles.kinds}>
                {configured.map((row) => (
                  <Pressable
                    key={row.provider}
                    accessibilityRole="button"
                    onPress={() => setProvider(row.provider)}
                    style={({ pressed }) =>
                      pressableStyle([styles.kind, provider === row.provider && styles.kindOn], { pressed })
                    }
                  >
                    <Text style={[styles.kindText, provider === row.provider && styles.kindTextOn]}>{row.provider}</Text>
                  </Pressable>
                ))}
              </View>
              {configured.length === 0 ? <Text style={styles.hint}>Add an AI provider in the account menu first.</Text> : null}
              <TextInput
                value={modelId}
                onChangeText={setModelId}
                placeholder="Model id"
                placeholderTextColor={colors.muted}
                keyboardAppearance="dark"
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
              />
              <PrimaryButton
                label="Create chat"
                disabled={!chatReady}
                onPress={() => onCreateChat(name.trim(), role.trim(), job.trim(), provider, modelId.trim())}
              />
            </>
          ) : (
            <>
              <TextInput value={title} onChangeText={setTitle} placeholder="Group name" placeholderTextColor={colors.muted} keyboardAppearance="dark" style={styles.input} />
              {agents.length < 2 ? <Text style={styles.hint}>Create at least two chats before a group.</Text> : null}
              {agents.map((agent) => (
                <Pressable
                  key={agent.id}
                  accessibilityRole="button"
                  onPress={() => toggle(agent.id)}
                  style={({ pressed }) => pressableStyle(styles.agent, { pressed })}
                >
                  <Text style={styles.agentName}>{agent.name}</Text>
                  {picked.includes(agent.id) ? <IconCheck /> : null}
                </Pressable>
              ))}
              <PrimaryButton label="Create group" disabled={!groupReady} onPress={() => onCreateGroup(title.trim(), picked)} />
            </>
          )}
      </ScrollView>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
  scrollContent: { padding: 14, paddingBottom: 28, gap: 10 },
  kinds: { flexDirection: "row", gap: 8 },
  kind: { flex: 1, height: 40, borderRadius: 14, backgroundColor: colors.card, alignItems: "center", justifyContent: "center" },
  kindOn: { backgroundColor: colors.text },
  kindText: { color: colors.text, fontSize: 15, fontWeight: "600" },
  kindTextOn: { color: colors.bg },
  input: { backgroundColor: colors.card, color: colors.text, borderRadius: 14, height: 48, paddingHorizontal: 14, fontSize: 16 },
  hint: { color: colors.muted, fontSize: 14 },
  agent: { flexDirection: "row", alignItems: "center", backgroundColor: colors.card, borderRadius: 14, paddingHorizontal: 14, height: 48 },
  agentName: { color: colors.text, fontSize: 16, flex: 1 },
});
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
