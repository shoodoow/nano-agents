import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../theme/tokens";
import type { Reaction } from "../api";

export const QUICK_EMOJI = ["👍", "❤️", "👀", "🚀", "😮", "✅"] as const;

/**
 * Shows tapbacks under a bubble plus a quick picker.
 * Why: Grok-style reactions acknowledge without new messages; grouping by
 * emoji keeps rows compact. Picker emits onPick for the parent to persist.
 * Input: reactions for one message, picker visibility, callbacks.
 * Output: reaction row view (empty when none and picker closed).
 */
export function Reactions({
  reactions,
  picking,
  onTogglePicker,
  onPick,
}: {
  reactions: Reaction[];
  picking: boolean;
  onTogglePicker: () => void;
  onPick: (emoji: string) => void;
}) {
  const grouped = new Map<string, number>();
  for (const reaction of reactions) grouped.set(reaction.emoji, (grouped.get(reaction.emoji) ?? 0) + 1);
  if (grouped.size === 0 && !picking) return null;
  return (
    <View style={styles.wrap}>
      <Pressable onPress={onTogglePicker} accessibilityLabel="Add reaction">
        <Text style={styles.chips}>
          {[...grouped.entries()].map(([emoji, count]) => `${emoji}${count > 1 ? ` ${count}` : ""}`).join("  ")}
          {grouped.size === 0 ? "React" : "  ＋"}
        </Text>
      </Pressable>
      {picking ? (
        <View style={styles.picker}>
          {QUICK_EMOJI.map((emoji) => (
            <Pressable key={emoji} onPress={() => onPick(emoji)} style={styles.key}>
              <Text style={styles.glyph}>{emoji}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 4, gap: 4 },
  chips: { color: colors.muted, fontSize: 13 },
  picker: { flexDirection: "row", gap: 4, backgroundColor: colors.control, borderRadius: 16, padding: 6, alignSelf: "flex-start" },
  key: { paddingHorizontal: 6, paddingVertical: 2 },
  glyph: { fontSize: 20 },
});
