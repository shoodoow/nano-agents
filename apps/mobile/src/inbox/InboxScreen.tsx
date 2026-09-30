import { useMemo, useState, type ReactNode } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { RosterAgent } from "../api";
import { colors } from "../theme/tokens";
import { Avatar } from "../ui/Avatar";
import { CircleButton } from "../ui/CircleButton";
import { IconPlus, IconReply, IconSearch } from "../ui/icons";

/**
 * Shows the account roster plus group rooms, in the Grok chat-list layout.
 * Why: groups previously vanished after creation — agents alone cannot
 * reopen them. The groups section lists every group room with member counts.
 * Input: agents, groups, and handlers for account, search, new chat,
 * opening one agent, and opening one group.
 * Output: the inbox screen.
 */
export function InboxScreen({
  agents,
  groups,
  pendingCount,
  onAccount,
  onNew,
  onOpen,
  onOpenGroup,
  menu,
}: {
  agents: RosterAgent[];
  groups: { id: string; title: string; memberCount: number }[];
  pendingCount?: number;
  onAccount: () => void;
  onNew: () => void;
  onOpen: (agent: RosterAgent) => void;
  onOpenGroup: (conversationId: string) => void;
  menu?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const visible = useMemo(() => agents.filter((agent) => !agent.hidden), [agents]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return visible;
    }
    return visible.filter((agent) => `${agent.name} ${agent.label} ${agent.role} ${agent.jobDescription}`.toLowerCase().includes(needle));
  }, [query, visible]);
  const featured = query.trim() ? undefined : (filtered.find((agent) => agent.pinned) ?? filtered[0]);
  const rows = featured ? filtered.filter((agent) => agent.id !== featured.id) : filtered;

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable accessibilityLabel="Account" accessibilityRole="button" onPress={onAccount} style={styles.account}>
          <Avatar id="account" size={36} person />
        </Pressable>
        <View style={styles.headerActions}>
          {pendingCount != null && pendingCount > 0 ? (
            <View style={styles.pingBadge} accessibilityLabel={`${pendingCount} unread pings`}>
              <Text style={styles.pingText}>{pendingCount > 99 ? "99+" : String(pendingCount)}</Text>
            </View>
          ) : null}
          <CircleButton label="Search" onPress={() => setSearching((open) => !open)}>
            <IconSearch />
          </CircleButton>
          <CircleButton label="New chat" onPress={onNew}>
            <IconPlus />
          </CircleButton>
        </View>
      </View>
      {searching ? (
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search"
          placeholderTextColor={colors.muted}
          keyboardAppearance="dark"
          autoCapitalize="none"
          style={styles.search}
        />
      ) : null}
      <FlatList
        data={rows}
        keyExtractor={(agent) => agent.id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          featured ? (
            <Pressable accessibilityRole="button" onPress={() => onOpen(featured)} style={styles.featured}>
              <Avatar id={featured.id} size={92} />
              <View style={styles.featuredName}>
                <Text style={styles.featuredLabel}>{featured.name}</Text>
                {featured.notify ? <View style={styles.online} accessibilityLabel="Notifications on" /> : null}
              </View>
            </Pressable>
          ) : (
            <Text style={styles.empty}>{agents.length === 0 ? "Sign up, then create a chat or a group." : "No matching agents."}</Text>
          )
        }
        ListFooterComponent={
          groups.length > 0 ? (
            <View style={styles.groups}>
              <Text style={styles.groupsTitle}>Groups</Text>
              {groups.map((group) => (
                <Pressable
                  key={group.id}
                  accessibilityRole="button"
                  onPress={() => onOpenGroup(group.id)}
                  style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                >
                  <Avatar id={group.id} size={46} />
                  <View style={styles.rowBody}>
                    <Text style={styles.name} numberOfLines={1}>
                      {group.title}
                    </Text>
                    <Text style={styles.preview} numberOfLines={1}>
                      {group.memberCount} {group.memberCount === 1 ? "member" : "members"}
                    </Text>
                  </View>
                </Pressable>
              ))}
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <Pressable accessibilityRole="button" onPress={() => onOpen(item)} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
            <Avatar id={item.id} size={46} round={item.name.length % 2 === 0} />
            <View style={styles.rowBody}>
              <View style={styles.rowTop}>
                <Text style={styles.name} numberOfLines={1}>
                  {item.name}
                </Text>
                {item.label && item.label !== item.name ? (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>{item.label}</Text>
                  </View>
                ) : null}
              </View>
              <View style={styles.previewRow}>
                <IconReply />
                <Text style={styles.preview} numberOfLines={1}>
                  {item.role || `Message ${item.name}`}
                </Text>
              </View>
            </View>
          </Pressable>
        )}
      />
      {menu ? <View style={styles.menu}>{menu}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 8 },
  account: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  headerActions: { flexDirection: "row", gap: 4, alignItems: "center" },
  pingBadge: { backgroundColor: colors.danger, borderRadius: 11, minWidth: 22, height: 22, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
  pingText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  menu: { position: "absolute", top: 60, left: 8, right: 8, bottom: 12 },
  search: {
    marginHorizontal: 16,
    marginTop: 8,
    backgroundColor: colors.bubble,
    color: colors.text,
    borderRadius: 18,
    paddingHorizontal: 16,
    height: 44,
    fontSize: 16,
  },
  list: { paddingBottom: 32 },
  groups: { marginTop: 8 },
  groupsTitle: { color: colors.muted, fontSize: 13, fontWeight: "700", textTransform: "uppercase", paddingHorizontal: 16, marginBottom: 4 },
  featured: { alignItems: "center", paddingTop: 36, paddingBottom: 28 },
  featuredName: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 14 },
  featuredLabel: { color: colors.text, fontSize: 16, fontWeight: "600" },
  online: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.online },
  empty: { color: colors.muted, textAlign: "center", marginTop: 80, fontSize: 16, paddingHorizontal: 32 },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 10, gap: 12 },
  pressed: { opacity: 0.6 },
  rowBody: { flex: 1, gap: 3 },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { color: colors.text, fontSize: 16, fontWeight: "600", flexShrink: 1 },
  badge: { backgroundColor: colors.control, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2 },
  badgeText: { color: colors.muted, fontSize: 13 },
  previewRow: { flexDirection: "row", alignItems: "center" },
  preview: { color: colors.muted, fontSize: 15, flex: 1 },
});
