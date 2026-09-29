import { Image, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import type { MessageBlock } from "../api";
import { colors } from "../theme/tokens";

/**
 * Renders one rich MessageBlock inside a bubble.
 * Why: send_message turns carry text/image/code/file/widget payloads; the
 * thread must show them inline like Grok instead of raw JSON or bare URLs.
 * Input: block + optional approve/deny handlers for approval widgets.
 * Output: the block view. Unknown widgets fall back to a summary line.
 */
export function BlockView({
  block,
  onApprove,
  onDeny,
}: {
  block: MessageBlock;
  onApprove?: () => void;
  onDeny?: () => void;
}) {
  if (block.kind === "text") return <RichText text={block.markdown} />;
  if (block.kind === "image") {
    return (
      <View style={styles.mediaWrap}>
        <Image source={{ uri: block.url }} style={styles.image} accessibilityLabel={block.alt ?? "Shared image"} />
        {block.alt ? <Text style={styles.caption}>{block.alt}</Text> : null}
      </View>
    );
  }
  if (block.kind === "code") {
    return (
      <View style={styles.codeWrap}>
        {block.language ? <Text style={styles.codeLang}>{block.language}</Text> : null}
        <Text style={styles.code}>{block.code}</Text>
      </View>
    );
  }
  if (block.kind === "file") {
    return (
      <Pressable style={styles.fileWrap} onPress={() => void Linking.openURL(block.url)}>
        <Text style={styles.fileName}>{block.name}</Text>
        <Text style={styles.fileHint}>Tap to open</Text>
      </Pressable>
    );
  }
  return <WidgetView widget={block.widget} props={block.props} onApprove={onApprove} onDeny={onDeny} />;
}

/**
 * Renders markdown-lite text with linkified URLs.
 * Why: keeps the text path dependency-free while matching old link behavior.
 * Input: raw markdown-ish text. Output: wrapped text with blue links.
 */
function RichText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/\S+)/g);
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

/**
 * Renders interactive widget cards (checklist/chart/approval/agent-card).
 * Why: widgets are how agents deliver structured work (plans, scores, review
 * queues) without pasting tables; approval cards wire directly to decide().
 * Input: widget kind + props + handlers. Output: card view or fallback text.
 */
function WidgetView({
  widget,
  props,
  onApprove,
  onDeny,
}: {
  widget: string;
  props: Record<string, unknown>;
  onApprove?: () => void;
  onDeny?: () => void;
}) {
  if (widget === "checklist") {
    const items = Array.isArray(props.items) ? (props.items as { label: string; done?: boolean }[]) : [];
    return (
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{String(props.title ?? "Checklist")}</Text>
        {items.map((item, index) => (
          <Text key={index} style={styles.cardLine}>
            {item.done ? "✅" : "⬜"} {item.label}
          </Text>
        ))}
      </View>
    );
  }
  if (widget === "chart") {
    const values = Array.isArray(props.values) ? (props.values as number[]) : [];
    const max = Math.max(1, ...values);
    return (
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{String(props.title ?? "Chart")}</Text>
        {values.map((value, index) => (
          <View key={index} style={styles.barRow}>
            <View style={[styles.bar, { flex: Math.max(0.05, value / max) }]} />
            <Text style={styles.barValue}>{String(value)}</Text>
          </View>
        ))}
      </View>
    );
  }
  if (widget === "approval") {
    return (
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{String(props.title ?? "Needs approval")}</Text>
        {props.detail ? <Text style={styles.cardLine}>{String(props.detail)}</Text> : null}
        <View style={styles.approvalRow}>
          <Pressable style={[styles.choice, styles.allow]} onPress={onApprove}>
            <Text style={styles.choiceText}>Approve</Text>
          </Pressable>
          <Pressable style={[styles.choice, styles.deny]} onPress={onDeny}>
            <Text style={styles.choiceText}>Deny</Text>
          </Pressable>
        </View>
      </View>
    );
  }
  if (widget === "agent-card") {
    return (
      <View style={styles.card}>
        <Text style={styles.cardTitle}>🤖 {String(props.label ?? props.name ?? "Subagent")}</Text>
        <Text style={styles.cardLine}>Specialist joined the room. Mention @{String(props.name ?? "")} to task it.</Text>
      </View>
    );
  }
  return <Text style={styles.body}>[widget:{widget}]</Text>;
}

const styles = StyleSheet.create({
  body: { color: colors.text, fontSize: 16, lineHeight: 24 },
  link: { color: colors.link },
  mediaWrap: { gap: 6 },
  image: { width: 240, height: 180, borderRadius: 12, backgroundColor: colors.control },
  caption: { color: colors.muted, fontSize: 13 },
  codeWrap: { backgroundColor: colors.control, borderRadius: 10, padding: 10, gap: 4 },
  codeLang: { color: colors.muted, fontSize: 12 },
  code: { color: colors.text, fontFamily: "monospace", fontSize: 13 },
  fileWrap: { backgroundColor: colors.control, borderRadius: 10, padding: 12, gap: 2 },
  fileName: { color: colors.text, fontWeight: "600" },
  fileHint: { color: colors.muted, fontSize: 12 },
  card: { backgroundColor: colors.control, borderRadius: 12, padding: 12, gap: 6, minWidth: 220 },
  cardTitle: { color: colors.text, fontWeight: "700", fontSize: 15 },
  cardLine: { color: colors.text, fontSize: 14, lineHeight: 20 },
  barRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  bar: { height: 10, borderRadius: 5, backgroundColor: colors.link },
  barValue: { color: colors.muted, fontSize: 12, width: 40 },
  approvalRow: { flexDirection: "row", gap: 8, marginTop: 4 },
  choice: { flex: 1, borderRadius: 10, paddingVertical: 10, alignItems: "center" },
  allow: { backgroundColor: "#1d5c2e" },
  deny: { backgroundColor: "#6e2b2b" },
  choiceText: { color: "#fff", fontWeight: "700" },
});
