import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { RosterAgent } from "../api";
import { colors } from "../theme/tokens";
import { Avatar } from "../ui/Avatar";
import { CircleButton } from "../ui/CircleButton";
import { IconClose } from "../ui/icons";

/**
 * Shows the agent menu opened from the chat header name pill.
 * Why: tapping the agent name must open this menu (Grok-style reference).
 * Input: the chat agent and the close action.
 * Output: the sheet overlay. Rows below the identity card are placeholders
 * until the design reference lands (TODO: fill from reference screenshots).
 */
export function AgentMenuSheet({ agent, onClose }: { agent: RosterAgent; onClose: () => void }) {
  return (
    <View style={styles.sheet}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <CircleButton label="Close agent menu" onPress={onClose}>
          <IconClose />
        </CircleButton>
        <View style={styles.card}>
          <Avatar id={agent.id} size={44} />
          <View style={styles.cardBody}>
            <Text style={styles.name}>{agent.name}</Text>
            {agent.role ? <Text style={styles.role}>{agent.role}</Text> : null}
          </View>
        </View>
        {/* TODO: fill rows from the design reference (avatar mark, tabs,
            character/color pickers, instructions, routines, notifications). */}
        <Pressable accessibilityRole="button" onPress={onClose} style={styles.card}>
          <View style={styles.cardBody}>
            <Text style={styles.rowLabel}>Menu content follows the design reference</Text>
            <Text style={styles.hint}>Close this sheet and send the screenshots as files or text.</Text>
          </View>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.sheet, borderRadius: 28, borderCurve: "continuous", overflow: "hidden" },
  scroll: { padding: 14, paddingBottom: 28, gap: 10 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.card,
    borderRadius: 16,
    borderCurve: "continuous",
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  cardBody: { flex: 1, gap: 2 },
  name: { color: colors.text, fontSize: 17, fontWeight: "600" },
  role: { color: colors.muted, fontSize: 14 },
  rowLabel: { color: colors.text, fontSize: 16, flex: 1 },
  hint: { color: colors.muted, fontSize: 13, lineHeight: 18 },
});
