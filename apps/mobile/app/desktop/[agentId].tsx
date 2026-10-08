import { router, useLocalSearchParams } from "expo-router";
import { Text, View } from "react-native";
import { DesktopScreen } from "../../src/desktop/DesktopScreen";
import { useSession } from "../../src/session/SessionProvider";
import { colors } from "../../src/theme/tokens";

export default function DesktopRoute() {
  const { agentId } = useLocalSearchParams<{ agentId: string }>();
  const session = useSession();
  const agent = session.desktopAgent?.id === agentId ? session.desktopAgent : session.agents.find((row) => row.id === agentId);

  if (!agent) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg }}>
        <Text style={{ color: colors.muted }}>This agent has no desktop yet.</Text>
      </View>
    );
  }

  return (
    <DesktopScreen
      accountId={session.accountId.trim()}
      agent={agent}
      onBack={() => router.back()}
      onApprovals={() => void session.refreshProposals().catch(session.show)}
      onError={session.show}
    />
  );
}
