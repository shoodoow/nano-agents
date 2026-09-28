import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { Proposal } from "../api";
import { colors } from "../theme/tokens";
import { CircleButton } from "../ui/CircleButton";
import { IconBack } from "../ui/icons";

/**
 * Lists pending proposals and approves or rejects one.
 * Input: the proposals and the decision handlers.
 * Output: the approvals screen.
 */
export function ApprovalsScreen({
  proposals,
  onApprove,
  onReject,
  onBack,
}: {
  proposals: Proposal[];
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onBack: () => void;
}) {
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <CircleButton label="Back" onPress={onBack}>
          <IconBack />
        </CircleButton>
        <Text style={styles.title}>Approvals</Text>
        <View style={styles.spacer} />
      </View>
      <ScrollView contentContainerStyle={styles.list}>
        {proposals.length === 0 ? <Text style={styles.empty}>No pending proposals.</Text> : null}
        {proposals.map((proposal) => (
          <View key={proposal.id} style={styles.card}>
            <Text style={styles.kind}>{proposal.kind}</Text>
            <Text style={styles.body}>{proposal.body}</Text>
            <View style={styles.actions}>
              <Pressable accessibilityRole="button" onPress={() => onApprove(proposal.id)} style={styles.action}>
                <Text style={styles.actionText}>Approve</Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={() => onReject(proposal.id)} style={styles.action}>
                <Text style={styles.rejectText}>Reject</Text>
              </Pressable>
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 8 },
  title: { color: colors.text, fontSize: 17, fontWeight: "600" },
  spacer: { width: 44 },
  list: { padding: 16, gap: 12 },
  empty: { color: colors.muted, textAlign: "center", marginTop: 48, fontSize: 16 },
  card: { backgroundColor: colors.bubble, borderRadius: 22, padding: 16 },
  kind: { color: colors.muted, fontSize: 13, marginBottom: 6 },
  body: { color: colors.text, fontSize: 16, lineHeight: 24 },
  actions: { flexDirection: "row", gap: 12, marginTop: 14 },
  action: { minHeight: 44, justifyContent: "center", paddingHorizontal: 4 },
  actionText: { color: colors.link, fontSize: 16, fontWeight: "600" },
  rejectText: { color: colors.danger, fontSize: 16, fontWeight: "600" },
});
