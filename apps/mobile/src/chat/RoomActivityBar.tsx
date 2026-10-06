import { StyleSheet, Text, View } from "react-native";
import type { RosterAgent } from "../api";
import { colors } from "../theme/tokens";
import { Avatar } from "../ui/Avatar";
import { roomActivityLabel, type RoomActivityPhase } from "./room-activity";

/**
 * Footer status while a turn is in flight (thinking, working, teammates).
 * Input: phase, agent roster row, group flag. Output: mark + status row.
 */
export function RoomActivityBar({
  phase,
  agent,
  isGroup,
}: {
  phase: RoomActivityPhase;
  agent: RosterAgent;
  isGroup: boolean;
}) {
  const label = roomActivityLabel(phase, agent.name, isGroup);
  const mood = phase === "working" || phase === "teammates" ? "working" : "idle";
  return (
    <View style={styles.row} accessibilityLiveRegion="polite" accessibilityLabel={label}>
      <Avatar
        id={agent.id}
        size={24}
        round
        shape={agent.markShape}
        color={agent.markColor}
        material={agent.markMaterial}
        style={agent.markStyle}
        gender={agent.markGender}
        photo={agent.avatarUrl}
        mood={mood}
      />
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 20,
    paddingBottom: 6,
    paddingTop: 2,
  },
  label: { color: colors.muted, fontSize: 13, flexShrink: 1 },
});
