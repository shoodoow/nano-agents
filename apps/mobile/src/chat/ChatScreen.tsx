import { useRef, useState } from "react";
import {
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { MessageBlock, Reaction, RosterAgent } from "../api";
import { colors } from "../theme/tokens";
import { Avatar } from "../ui/Avatar";
import { CircleButton } from "../ui/CircleButton";
import { IconBack, IconMic, IconMonitor, IconPlus, IconWave } from "../ui/icons";
import { BlockView } from "./blocks";
import { Reactions } from "./Reactions";

export type Bubble = {
  id: string;
  author: string;
  body: string;
  time: string;
  blocks?: MessageBlock[] | null;
  replyTo?: string | null;
  replyPreview?: string | null;
  via?: string | null;
  reactions?: Reaction[];
};

export type ComposerAttachment = {
  id: string;
  kind: "image" | "file";
  url: string;
  name?: string;
};

const INPUT_MAX_HEIGHT = 120;

/**
 * Shows one rich thread with a stretching composer and attachments.
 * Why: long SEO-style briefs need a multiline box that grows with the text
 * (capped so it never eats the thread); images/files attach via the + sheet
 * and ride the same send as blocks — no second input row.
 * Input: agent, bubbles, draft/sending/typing/error, reply target,
 * attachments + sheet flag, and chat actions.
 * Output: the conversation screen.
 */
export function ChatScreen({
  agent,
  messages,
  draft,
  sending,
  typing,
  error,
  replyTo,
  attachments,
  attachOpen,
  onDraft,
  onSend,
  onAttach,
  onCloseAttach,
  onPickImage,
  onPickFile,
  onRemoveAttachment,
  onMention,
  onReply,
  onClearReply,
  onReact,
  onApprove,
  onDeny,
  onBack,
  onDesktop,
}: {
  agent: RosterAgent;
  messages: Bubble[];
  draft: string;
  sending: boolean;
  typing: boolean;
  error: string;
  replyTo: Bubble | null;
  attachments: ComposerAttachment[];
  attachOpen: boolean;
  onDraft: (value: string) => void;
  onSend: () => void;
  onAttach: () => void;
  onCloseAttach: () => void;
  onPickImage: () => void;
  onPickFile: () => void;
  onRemoveAttachment: (id: string) => void;
  onMention: () => void;
  onReply: (bubble: Bubble) => void;
  onClearReply: () => void;
  onReact: (bubble: Bubble, emoji: string) => void;
  onApprove: () => void;
  onDeny: () => void;
  onBack: () => void;
  onDesktop: () => void;
}) {
  const list = useRef<FlatList<Bubble>>(null);
  const [pickingFor, setPickingFor] = useState<string | null>(null);

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
          const blocks: MessageBlock[] =
            item.blocks && item.blocks.length > 0 ? item.blocks : [{ kind: "text", markdown: item.body }];
          return (
            <View>
              {showTime ? <Text style={styles.time}>Today {item.time}</Text> : null}
              <Pressable
                onLongPress={() => onReply(item)}
                style={styles.bubble}
                accessibilityLabel={`${item.author}. ${item.body}`}
              >
                {item.replyPreview ? <Text style={styles.quote}>↩ {item.replyPreview}</Text> : null}
                {item.via ? <Text style={styles.via}>via {item.via}</Text> : null}
                {blocks.map((block, blockIndex) => (
                  <BlockView key={blockIndex} block={block} onApprove={onApprove} onDeny={onDeny} />
                ))}
                <Reactions
                  reactions={item.reactions ?? []}
                  picking={pickingFor === item.id}
                  onTogglePicker={() => setPickingFor((current) => (current === item.id ? null : item.id))}
                  onPick={(emoji) => {
                    setPickingFor(null);
                    onReact(item, emoji);
                  }}
                />
              </Pressable>
            </View>
          );
        }}
      />
      {typing ? <Text style={styles.typing}>●●● typing</Text> : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {replyTo ? (
        <Pressable style={styles.replyBar} onPress={onClearReply}>
          <Text style={styles.replyText}>↩ {replyTo.body.slice(0, 80)} ✕</Text>
        </Pressable>
      ) : null}
      {attachments.length > 0 ? (
        <View style={styles.chips}>
          {attachments.map((attachment) => (
            <View key={attachment.id} style={styles.chip}>
              {attachment.kind === "image" ? (
                <Image source={{ uri: attachment.url }} style={styles.thumb} />
              ) : (
                <Text style={styles.fileGlyph}>📄</Text>
              )}
              <Text style={styles.chipName} numberOfLines={1}>
                {attachment.name ?? "image"}
              </Text>
              <Pressable onPress={() => onRemoveAttachment(attachment.id)} accessibilityLabel="Remove attachment">
                <Text style={styles.chipX}>✕</Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      <View style={styles.composer}>
        <CircleButton label="Attach" onPress={onAttach}>
          <IconPlus />
        </CircleButton>
        <TextInput
          value={draft}
          onChangeText={onDraft}
          placeholder={`Ask ${agent.name}`}
          placeholderTextColor={colors.muted}
          keyboardAppearance="dark"
          style={styles.input}
          multiline
          maxLength={20000}
          editable={!sending}
          scrollEnabled
          textAlignVertical="top"
        />
        <Pressable accessibilityLabel="Voice" accessibilityState={{ disabled: true }} style={styles.mic}>
          <IconMic />
        </Pressable>
        <CircleButton label="Send" onPress={onSend}>
          <IconWave />
        </CircleButton>
      </View>
      <Modal visible={attachOpen} transparent animationType="fade" onRequestClose={onCloseAttach}>
        <Pressable style={styles.sheetBackdrop} onPress={onCloseAttach}>
          <View style={styles.sheet}>
            <Pressable style={styles.sheetRow} onPress={onPickImage}>
              <Text style={styles.sheetText}>🖼  Photo library</Text>
            </Pressable>
            <Pressable style={styles.sheetRow} onPress={onPickFile}>
              <Text style={styles.sheetText}>📄  File</Text>
            </Pressable>
            <Pressable style={styles.sheetRow} onPress={onMention}>
              <Text style={styles.sheetText}>@  Mention {agent.name}</Text>
            </Pressable>
            <Pressable style={[styles.sheetRow, styles.sheetCancel]} onPress={onCloseAttach}>
              <Text style={styles.sheetText}>Cancel</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
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
  bubble: { backgroundColor: colors.bubble, borderRadius: 22, paddingHorizontal: 16, paddingVertical: 14, gap: 6 },
  quote: { color: colors.muted, fontSize: 13, borderLeftWidth: 2, borderLeftColor: colors.link, paddingLeft: 8 },
  via: { color: colors.muted, fontSize: 12 },
  typing: { color: colors.muted, paddingHorizontal: 20, paddingBottom: 4, fontSize: 13 },
  error: { color: colors.danger, paddingHorizontal: 20, paddingBottom: 6, fontSize: 14 },
  replyBar: { backgroundColor: colors.control, marginHorizontal: 12, borderRadius: 10, padding: 8 },
  replyText: { color: colors.text, fontSize: 13 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: 12, paddingBottom: 4 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.control,
    borderRadius: 14,
    paddingVertical: 4,
    paddingHorizontal: 8,
    maxWidth: 220,
  },
  thumb: { width: 28, height: 28, borderRadius: 8 },
  fileGlyph: { fontSize: 20 },
  chipName: { color: colors.text, fontSize: 12, flexShrink: 1 },
  chipX: { color: colors.muted, fontSize: 14, paddingHorizontal: 4 },
  composer: { flexDirection: "row", alignItems: "flex-end", paddingHorizontal: 8, paddingBottom: 8, gap: 2 },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: INPUT_MAX_HEIGHT,
    borderRadius: 22,
    backgroundColor: colors.bubble,
    color: colors.text,
    paddingHorizontal: 16,
    paddingTop: 11,
    paddingBottom: 11,
    fontSize: 16,
  },
  mic: { width: 36, height: 44, alignItems: "center", justifyContent: "center", opacity: 0.45 },
  sheetBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.control, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 12, gap: 4 },
  sheetRow: { paddingVertical: 14, paddingHorizontal: 12, borderRadius: 10 },
  sheetCancel: { alignItems: "center", marginTop: 4, backgroundColor: colors.bubble },
  sheetText: { color: colors.text, fontSize: 16 },
});
