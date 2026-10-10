import type { ReactNode } from "react";
import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import type { Reaction } from "../api";

// Server allowlist (shared reactionSchema) — the only emoji that may be sent.
export const QUICK_EMOJI = ["👍", "❤️", "👀", "🚀", "😮", "✅"] as const;

export type MessageAction = { label: string; icon: ReactNode; onPress: () => void };
/** Where a bubble sits in the window, from measureInWindow. */
export type BubbleFrame = { x: number; y: number; width: number; height: number };

/**
 * Shows the tapbacks already on a message as small chips.
 * Nothing renders for a message with no reactions, so holding a bubble never
 * changes its height. Tapping a chip adds or removes your own reaction.
 * Input: reactions + pick callback. Output: the chips row, or nothing.
 */
export function ReactionChips({ reactions, onPick }: { reactions: Reaction[]; onPick: (emoji: string) => void }) {
  const grouped = new Map<string, number>();
  for (const reaction of reactions) grouped.set(reaction.emoji, (grouped.get(reaction.emoji) ?? 0) + 1);
  if (grouped.size === 0) return null;
  return (
    <View style={styles.chipsRow}>
      {[...grouped.entries()].map(([emoji, count]) => (
        <Pressable
          key={emoji}
          style={styles.chip}
          hitSlop={4}
          onPress={() => onPick(emoji)}
          accessibilityRole="button"
          accessibilityLabel={`${emoji} ${count}`}
        >
          <Text style={styles.chipEmoji}>{emoji}</Text>
          {count > 1 ? <Text style={styles.count}>{count}</Text> : null}
        </Pressable>
      ))}
    </View>
  );
}

const BAR_HEIGHT = 50;
const ROW_HEIGHT = 46;
const GAP = 8;

/**
 * The hold menu, Telegram style: a row of emoji just above the held bubble
 * and the actions (Reply, Copy, Select Text) just below it, on the bubble's
 * own side of the screen.
 * Why: the old panel opened in the middle of the screen, away from the
 * message it was about. Emoji are drawn with the system emoji font.
 * Input: the bubble's frame (null = closed), its side, callbacks, actions.
 * Output: the floating menu over a light scrim.
 */
export function MessageMenu({
  frame,
  mine,
  actions,
  onPick,
  onClose,
}: {
  frame: BubbleFrame | null;
  mine: boolean;
  actions: MessageAction[];
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  if (!frame) return null;
  // A bubble taller than the screen leaves no room above or below it, so both
  // parts are held inside the safe area and may then sit over the bubble.
  const menuHeight = actions.length * ROW_HEIGHT;
  const floor = window.height - insets.bottom - 12;
  const barTop = Math.min(
    Math.max(frame.y - BAR_HEIGHT - GAP, insets.top + 8),
    floor - menuHeight - GAP - BAR_HEIGHT,
  );
  const menuTop = Math.max(Math.min(frame.y + frame.height + GAP, floor - menuHeight), barTop + BAR_HEIGHT + GAP);
  const side = mine ? { right: 12 } : { left: Math.max(12, Math.min(frame.x, 52)) };
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close menu">
        <View style={[styles.bar, side, { top: barTop }]}>
          {QUICK_EMOJI.map((emoji) => (
            <Pressable
              key={emoji}
              accessibilityRole="button"
              accessibilityLabel={`React ${emoji}`}
              onPress={() => onPick(emoji)}
              style={({ pressed }) => [styles.key, pressed ? styles.keyPressed : null]}
            >
              <Text style={styles.keyEmoji}>{emoji}</Text>
            </Pressable>
          ))}
        </View>
        <View style={[styles.menu, side, { top: menuTop }]}>
          {actions.map((action, index) => (
            <Pressable
              key={action.label}
              accessibilityRole="button"
              onPress={action.onPress}
              style={({ pressed }) => [styles.menuRow, index > 0 ? styles.menuDivider : null, pressed ? styles.menuPressed : null]}
            >
              <Text style={styles.menuLabel}>{action.label}</Text>
              {action.icon}
            </Pressable>
          ))}
        </View>
      </Pressable>
    </Modal>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
    chipsRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 4 },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: colors.control,
      borderRadius: 12,
      paddingVertical: 3,
      paddingHorizontal: 8,
    },
    chipEmoji: { fontSize: 15 },
    count: { color: colors.muted, fontSize: 12, fontWeight: "600" },
    backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)" },
    bar: {
      position: "absolute",
      height: BAR_HEIGHT,
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.control,
      borderRadius: BAR_HEIGHT / 2,
      borderCurve: "continuous",
      paddingHorizontal: 6,
      boxShadow: "0 8px 16px rgba(0, 0, 0, 0.35)",
    },
    key: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
    keyPressed: { backgroundColor: colors.line },
    keyEmoji: { fontSize: 28 },
    menu: {
      position: "absolute",
      width: 230,
      backgroundColor: colors.control,
      borderRadius: 16,
      borderCurve: "continuous",
      overflow: "hidden",
      boxShadow: "0 8px 16px rgba(0, 0, 0, 0.35)",
    },
    menuRow: {
      height: ROW_HEIGHT,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
    },
    menuDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
    menuPressed: { backgroundColor: colors.line },
    menuLabel: { color: colors.text, fontSize: 16 },
  });
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
