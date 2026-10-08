import { Image, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import type { Reaction } from "../api";

// Server allowlist (shared reactionSchema) — the only emoji that may be sent.
export const QUICK_EMOJI = ["👍", "❤️", "👀", "🚀", "😮", "✅"] as const;

// Twemoji PNGs pinned to v14.0.2: device fonts cannot be trusted (several
// Android builds and simulators draw tofu boxes even for common emoji), so
// reactions render as images, never glyphs. 72px assets scale down cleanly.
const TWEMOJI = "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72";
const EMOJI_IMG: Record<string, string> = {
  "👍": `${TWEMOJI}/1f44d.png`,
  "❤️": `${TWEMOJI}/2764.png`,
  "👀": `${TWEMOJI}/1f440.png`,
  "🚀": `${TWEMOJI}/1f680.png`,
  "😮": `${TWEMOJI}/1f62e.png`,
  "✅": `${TWEMOJI}/2705.png`,
};

/**
 * Renders one reaction emoji as an image.
 * Why: system emoji fonts are missing on some devices (tofu boxes), so every
 * reaction pixel comes from the pinned Twemoji set instead. Falls back to a
 * grey dot for unmapped emoji rather than a box.
 * Input: bare server emoji + pixel size. Output: the image (or fallback dot).
 */
export function EmojiImg({ emoji, size }: { emoji: string; size: number }) {
  const uri = EMOJI_IMG[emoji];
  if (!uri) {
    return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.muted }} />;
  }
  return (
    <Image source={{ uri }} style={{ width: size, height: size }} accessibilityLabel={emoji} resizeMode="contain" />
  );
}

/**
 * Shows grouped tapbacks plus a Telegram-style floating emoji panel.
 * Why: hold-to-react opens a centered dark pill with big image glyphs
 * (vertical, like Telegram) instead of an inline row; tapbacks stay compact
 * underneath as image + count. No system emoji font is ever required.
 * Input: reactions, panel visibility, dismiss + pick callbacks.
 * Output: chips row, and a modal panel while picking.
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
        <View style={styles.chipsRow}>
          {[...grouped.entries()].map(([emoji, count]) => (
            <View key={emoji} style={styles.chip}>
              <EmojiImg emoji={emoji} size={16} />
              {count > 1 ? <Text style={styles.count}>{count}</Text> : null}
            </View>
          ))}
          <Text style={styles.more}>{grouped.size === 0 ? "React" : "＋"}</Text>
        </View>
      </Pressable>
      <Modal visible={picking} transparent animationType="fade" onRequestClose={onTogglePicker}>
        <Pressable style={styles.backdrop} onPress={onTogglePicker}>
          <View style={styles.panel}>
            {QUICK_EMOJI.map((emoji) => (
              <Pressable
                key={emoji}
                accessibilityRole="button"
                accessibilityLabel={`React ${emoji}`}
                onPress={() => onPick(emoji)}
                style={styles.key}
              >
                <EmojiImg emoji={emoji} size={44} />
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
  wrap: { marginTop: 4, gap: 4 },
  chipsRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.control,
    borderRadius: 12,
    paddingVertical: 3,
    paddingHorizontal: 8,
  },
  count: { color: colors.muted, fontSize: 12, fontWeight: "600" },
  more: { color: colors.muted, fontSize: 13 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center" },
  panel: {
    backgroundColor: "#1E1E20",
    borderRadius: 32,
    paddingVertical: 10,
    paddingHorizontal: 14,
    gap: 2,
    alignItems: "center",
    boxShadow: "0 8px 16px rgba(0, 0, 0, 0.35)",
  },
  key: { paddingVertical: 6, paddingHorizontal: 8 },
});
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
