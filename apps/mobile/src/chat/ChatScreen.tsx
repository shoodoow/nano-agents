import { useRef } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { RosterAgent } from "../api";
import { colors } from "../theme/tokens";
import { Avatar } from "../ui/Avatar";
import { CircleButton } from "../ui/CircleButton";
import { IconBack, IconMic, IconMonitor, IconPlus, IconWave } from "../ui/icons";

export type Bubble = { id: string; author: string; body: string; time: string };

/**
 * Shows one agent's thread and the composer.
 * Input: the agent, the bubbles, the draft, and the chat actions.
 * Output: the conversation screen.
 */
export function ChatScreen({
  agent,
  messages,
  draft,
  sending,
  error,
  onDraft,
  onSend,
  onMention,
  onBack,
  onDesktop,
}: {
  agent: RosterAgent;
  messages: Bubble[];
  draft: string;
  sending: boolean;
  error: string;
  onDraft: (value: string) => void;
  onSend: () => void;
  onMention: () => void;
  onBack: () => void;
  onDesktop: () => void;
}) {
  const list = useRef<FlatList<Bubble>>(null);

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.header}>
        <CircleButton label="Back" onPress={onBack}>
          <IconBack />
        </CircleButton>
        <View style={styles.pill}>
          <Avatar id={agent.id} size={22} round />
          <Text style={styles.pillName}>{agent.name}</Text>
        </View>
        {agent.linuxProfile ? (
          <CircleButton label="Desktop" onPress={onDesktop}>
            <IconMonitor />
          </CircleButton>
        ) : (
          <View style={styles.headerSpacer} />
        )}
      </View>
      <FlatList
        ref={list}
        data={messages}
        keyExtractor={(message) => message.id}
        contentContainerStyle={styles.thread}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
        renderItem={({ item, index }) => {
          const previous = messages[index - 1];
          const showTime = !previous || previous.time !== item.time;
          return (
            <View>
              {showTime ? <Text style={styles.time}>Today {item.time}</Text> : null}
              <View style={styles.bubble} accessibilityLabel={`${item.author}. ${item.body}`}>
                <MessageBody body={item.body} />
              </View>
            </View>
          );
        }}
      />
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      <View style={styles.composer}>
        <CircleButton label={`Mention @${agent.name}`} onPress={onMention}>
          <IconPlus />
        </CircleButton>
        <TextInput
          value={draft}
          onChangeText={onDraft}
          placeholder={`Ask ${agent.name}`}
          placeholderTextColor={colors.muted}
          keyboardAppearance="dark"
          style={styles.input}
          onSubmitEditing={onSend}
          editable={!sending}
        />
        <Pressable accessibilityLabel="Voice" accessibilityState={{ disabled: true }} style={styles.mic}>
          <IconMic />
        </Pressable>
        <CircleButton label="Send" onPress={onSend}>
          <IconWave />
        </CircleButton>
      </View>
    </KeyboardAvoidingView>
  );
}

/**
 * Renders message text and turns URLs into links.
 * Input: the message body.
 * Output: white text with blue links.
 */
function MessageBody({ body }: { body: string }) {
  const parts = body.split(/(https?:\/\/\S+)/g);
  return (
    <Text style={styles.body}>
      {parts.map((part, index) =>
        part.startsWith("http") ? (
          <Text key={index} style={styles.link} onPress={() => void Linking.openURL(part)}>
            {part}
          </Text>
        ) : (
          <Text key={index}>{part}</Text>
        ),
      )}
    </Text>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 8,
    paddingTop: 4,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.control,
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: 10,
    maxWidth: "60%",
  },
  pillName: { color: colors.text, fontSize: 16, fontWeight: "600" },
  headerSpacer: { width: 44 },
  thread: { paddingHorizontal: 12, paddingTop: 12, paddingBottom: 16, gap: 8 },
  time: { color: colors.muted, textAlign: "center", fontSize: 13, marginVertical: 10 },
  bubble: { backgroundColor: colors.bubble, borderRadius: 22, paddingHorizontal: 16, paddingVertical: 14 },
  body: { color: colors.text, fontSize: 16, lineHeight: 24 },
  link: { color: colors.link },
  error: { color: colors.danger, paddingHorizontal: 20, paddingBottom: 6, fontSize: 14 },
  composer: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingBottom: 8, gap: 2 },
  input: {
    flex: 1,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.bubble,
    color: colors.text,
    paddingHorizontal: 16,
    fontSize: 16,
  },
  mic: { width: 36, height: 44, alignItems: "center", justifyContent: "center", opacity: 0.45 },
});
