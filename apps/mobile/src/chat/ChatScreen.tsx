import { useRef, useState, type ReactNode } from "react";
import {
  Animated,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { MessageBlock, Reaction, RosterAgent } from "../api";
import { colors } from "../theme/tokens";
import { Avatar, colorFor } from "../ui/Avatar";
import { CircleButton } from "../ui/CircleButton";
import { IconBack, IconMonitor, IconPlus } from "../ui/icons";
import { BlockView } from "./blocks";
import { Reactions } from "./Reactions";

export type Bubble = {
  id: string;
  author: string;
  agentId: string | null;
  mine: boolean;
  body: string;
  /** ISO timestamp for thread ordering (server createdAt or client pending time). */
  sortAt: string;
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
 * Wraps a bubble with pull-right-to-reply, Telegram style.
 * Why: horizontal drags past the threshold reply; vertical drags stay with
 * the list because activation requires dominant horizontal movement. The
 * bubble follows the finger up to 72px with a ↩ hint, then springs home.
 * A stationary hold never activates it, so Pressable long-press (reactions)
 * keeps working.
 * Input: swipe callback + children. Output: the gesture wrapper.
 */
function SwipeableBubble({ onSwipe, children }: { onSwipe: () => void; children: ReactNode }) {
  const x = useRef(new Animated.Value(0)).current;
  const [hint, setHint] = useState(false);
  const responder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gesture) =>
        Math.abs(gesture.dx) > 18 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.6,
      onPanResponderMove: (_event, gesture) => {
        const value = Math.max(0, Math.min(72, gesture.dx));
        x.setValue(value);
        setHint(value > 48);
      },
      onPanResponderRelease: (_event, gesture) => {
        if (gesture.dx > 48) {
          onSwipe();
        }
        Animated.spring(x, { toValue: 0, useNativeDriver: true }).start();
        setHint(false);
      },
      onPanResponderTerminate: () => {
        Animated.spring(x, { toValue: 0, useNativeDriver: true }).start();
        setHint(false);
      },
    }),
  ).current;
  return (
    <View style={styles.swipeWrap}>
      {hint ? <Text style={styles.swipeHint}>↩</Text> : null}
      <Animated.View style={{ transform: [{ translateX: x }] }} {...responder.panHandlers}>
        {children}
      </Animated.View>
    </View>
  );
}

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
  title,
  subtitle,
  members,
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
  onFetchBlob,
  onBack,
  onDesktop,
  onAgentMenu,
  agentMenu,
}: {
  agent: RosterAgent;
  title: string;
  subtitle: string;
  members: { id: string; name: string }[];
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
  onFetchBlob: (messageId: string, index: number) => Promise<{ url?: string; previewUrl?: string }>;
  onBack: () => void;
  onDesktop: () => void;
  onAgentMenu: () => void;
  agentMenu?: ReactNode;
}) {
  const list = useRef<FlatList<Bubble>>(null);
  const [pickingFor, setPickingFor] = useState<string | null>(null);
  // @ mention autocomplete: matches a trailing @word in the draft and offers
  // room members starting with it. A trailing space (finished mention) hides it.
  const mentionQuery = /@([A-Za-z0-9_-]*)$/.exec(draft)?.[1]?.toLowerCase() ?? null;
  const mentionCandidates =
    mentionQuery === null
      ? []
      : members.filter((member) => member.name.toLowerCase().startsWith(mentionQuery)).slice(0, 5);

  /**
   * Inserts the picked member mention at the trailing @word.
   * Input: the member name. Output: nothing. Draft keeps "@name " format.
   */
  function pickMention(name: string): void {
    const at = draft.lastIndexOf("@");
    if (at < 0) {
      return;
    }
    onDraft(`${draft.slice(0, at)}@${name} `);
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.header}>
        <CircleButton label="Back" onPress={onBack}>
          <IconBack />
        </CircleButton>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Agent details for ${title}`}
          onPress={onAgentMenu}
          style={styles.pill}
        >
          <Avatar id={agent.id} size={22} round />
          <View style={styles.titles}>
            <Text style={styles.pillName} numberOfLines={1}>
              {title}
            </Text>
            {subtitle ? (
              <Text style={styles.pillSub} numberOfLines={1}>
                {subtitle}
              </Text>
            ) : null}
          </View>
        </Pressable>
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
        ListEmptyComponent={
          typing ? null : (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>This is the start of {title}</Text>
              <Text style={styles.emptyHint}>
                {members.length > 0 ? "Say hi below — type @ to mention a member." : "Say hi below to start."}
              </Text>
            </View>
          )
        }
        renderItem={({ item, index }) => {
          const previous = messages[index - 1];
          const showTime = !previous || previous.time !== item.time;
          const blocks: MessageBlock[] =
            item.blocks && item.blocks.length > 0 ? item.blocks : [{ kind: "text", markdown: item.body }];
          const nameColor = item.mine ? colors.text : colorFor(item.agentId ?? item.author);
          return (
            <View>
              {showTime ? <Text style={styles.time}>Today {item.time}</Text> : null}
              <View style={[styles.row, item.mine ? styles.rowMine : styles.rowTheirs]}>
                {!item.mine ? <Avatar id={item.agentId ?? item.author} size={32} round /> : null}
                <View style={styles.column}>
                  {!item.mine ? (
                    <Text style={[styles.author, { color: nameColor }]} numberOfLines={1}>
                      {item.author}
                      {item.via ? <Text style={styles.viaInline}> · via {item.via}</Text> : null}
                    </Text>
                  ) : null}
                  <SwipeableBubble onSwipe={() => onReply(item)}>
                    <Pressable
                      onLongPress={() => setPickingFor((current) => (current === item.id ? null : item.id))}
                      delayLongPress={350}
                      style={[styles.bubble, item.mine ? styles.bubbleMine : styles.bubbleTheirs]}
                      accessibilityLabel={`${item.author}. ${item.body}`}
                    >
                      {item.replyPreview ? <Text style={styles.quote}>↩ {item.replyPreview}</Text> : null}
                      {blocks.map((block, blockIndex) => (
                        <BlockView key={blockIndex} block={block} onApprove={onApprove} onDeny={onDeny} fetchBlob={onFetchBlob} />
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
                  </SwipeableBubble>
                </View>
              </View>
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
      {mentionCandidates.length > 0 ? (
        <View style={styles.mentions}>
          {mentionCandidates.map((member) => (
            <Pressable key={member.id} style={styles.mentionRow} onPress={() => pickMention(member.name)}>
              <Avatar id={member.id} size={24} round />
              <Text style={styles.mentionName}>{member.name}</Text>
            </Pressable>
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
          placeholder={`Message ${title}`}
          placeholderTextColor={colors.muted}
          keyboardAppearance="dark"
          style={styles.input}
          multiline
          maxLength={20000}
          editable={!sending}
          scrollEnabled
          textAlignVertical="top"
        />
        <Pressable accessibilityLabel="Send" accessibilityRole="button" onPress={onSend} style={styles.send}>
          <Text style={styles.sendText}>Send</Text>
        </Pressable>
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
      {agentMenu ? <View style={styles.agentMenu}>{agentMenu}</View> : null}
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
  titles: { flexShrink: 1 },
  pillSub: { color: colors.muted, fontSize: 12 },
  empty: { alignItems: "center", paddingVertical: 32, gap: 6 },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: "600" },
  emptyHint: { color: colors.muted, fontSize: 14, textAlign: "center", paddingHorizontal: 32 },
  mentions: {
    marginHorizontal: 12,
    marginBottom: 4,
    backgroundColor: colors.control,
    borderRadius: 14,
    overflow: "hidden",
  },
  mentionRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, paddingHorizontal: 12 },
  mentionName: { color: colors.text, fontSize: 16 },
  headerSpacer: { width: 44 },
  thread: { paddingHorizontal: 12, paddingTop: 12, paddingBottom: 16, gap: 8 },
  time: { color: colors.muted, textAlign: "center", fontSize: 13, marginVertical: 10 },
  row: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  rowMine: { justifyContent: "flex-end" },
  rowTheirs: { justifyContent: "flex-start" },
  column: { flexShrink: 1, maxWidth: "85%", gap: 2 },
  author: { fontSize: 14, fontWeight: "700", paddingLeft: 12 },
  viaInline: { color: colors.muted, fontWeight: "400", fontSize: 12 },
  swipeWrap: { flexDirection: "row", alignItems: "center", gap: 6 },
  swipeHint: { color: colors.link, fontSize: 22, fontWeight: "700" },
  bubble: { borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10, gap: 6 },
  bubbleMine: { backgroundColor: colors.online, borderBottomRightRadius: 6 },
  bubbleTheirs: { backgroundColor: colors.bubble, borderBottomLeftRadius: 6 },
  quote: { color: colors.muted, fontSize: 13, borderLeftWidth: 2, borderLeftColor: colors.link, paddingLeft: 8 },
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
  send: {
    minWidth: 64,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.link,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  sendText: { color: "#fff", fontSize: 16, fontWeight: "700" },
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
  sheetBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.control, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 12, gap: 4 },
  sheetRow: { paddingVertical: 14, paddingHorizontal: 12, borderRadius: 10 },
  sheetCancel: { alignItems: "center", marginTop: 4, backgroundColor: colors.bubble },
  sheetText: { color: colors.text, fontSize: 16 },
  agentMenu: { position: "absolute", top: 60, left: 8, right: 8, bottom: 12 },
});
