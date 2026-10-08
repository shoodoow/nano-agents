import { router, useLocalSearchParams } from "expo-router";
import { Text, View } from "react-native";
import { createCore } from "../../src/api";
import { GroupInfoScreen } from "../../src/chat/GroupInfoScreen";
import { useSession } from "../../src/session/SessionProvider";
import { colors } from "../../src/theme/tokens";
import type { RosterAgent } from "../../src/api";

const core = createCore();

export default function GroupRoute() {
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const session = useSession();
  const chat = session.lastChat?.conversationId === conversationId ? session.lastChat : null;

  if (!chat) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg }}>
        <Text style={{ color: colors.muted }}>Opening group…</Text>
      </View>
    );
  }

  const members = chat.memberIds
    .map((id) => session.agents.find((agent) => agent.id === id))
    .filter((agent): agent is RosterAgent => Boolean(agent));

  return (
    <GroupInfoScreen
      title={chat.title}
      members={members}
      messages={session.groupFeed}
      onBack={() => router.back()}
      onOpenMember={(member) => void session.openAgent(member).catch(session.show)}
      onFetchBlob={(roomId, messageId, index) => core.blob(session.accountId.trim(), roomId, messageId, index)}
    />
  );
}
