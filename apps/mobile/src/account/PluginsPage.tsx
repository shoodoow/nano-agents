import { useEffect, useMemo, useState } from "react";
import { AppState, Image, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { PluginCard, PluginList } from "../api";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { CircleButton } from "../ui/CircleButton";
import { PrimaryButton } from "../ui/PrimaryButton";
import { pressableStyle } from "../ui/pressableStyles";
import { IconClose, IconPlus, IconSearch } from "../ui/icons";

/**
 * Browses featured plugins and this account's own connectors.
 * Input: the catalog, and add, remove, and custom handlers.
 * Output: the plugins page. Another account's connectors are not in the list.
 */
export function PluginsPage({
  plugins,
  onCustom,
  onAdd,
  onRemove,
  onRefresh,
  scrollStyle,
}: {
  plugins: PluginList | null;
  onCustom: () => void;
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
  onRefresh: () => void;
  scrollStyle: ViewStyle;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<PluginCard | null>(null);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") onRefresh();
    });
    return () => sub.remove();
  }, [onRefresh]);
  const rows = plugins?.plugins ?? [];
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? rows.filter((row) => `${row.name} ${row.description}`.toLowerCase().includes(needle)) : rows;
  }, [query, rows]);
  const sections = [...new Set(visible.map((row) => row.section))];
  return (
    <ScrollView style={scrollStyle} contentInsetAdjustmentBehavior="automatic" nestedScrollEnabled contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <View style={styles.count}>
          <Text style={styles.countText}>{plugins?.installed ?? 0} installed</Text>
        </View>
        <CircleButton label="Add your MCP" onPress={onCustom}>
          <IconPlus />
        </CircleButton>
      </View>
      <View style={styles.search}>
        <IconSearch />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search plugins"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardAppearance="dark"
          style={styles.searchInput}
        />
      </View>
      {sections.map((section) => (
        <View key={section} style={styles.sectionBlock}>
          <Text style={styles.section}>{section}</Text>
          {visible
            .filter((row) => row.section === section)
            .map((row) => {
              const live = rows.find((item) => item.id === row.id) ?? row;
              return (
                <Pressable
                  key={row.id}
                  accessibilityRole="button"
                  onPress={() => setSelected(live)}
                  style={({ pressed }) => pressableStyle(styles.row, { pressed })}
                >
                  <PluginGlyph mark={live.mark} name={live.name} />
                  <View style={styles.body}>
                    <Text style={styles.name}>{live.name}</Text>
                    <Text style={styles.description} numberOfLines={2}>
                      {live.description}
                    </Text>
                    {live.lastError ? <Text style={styles.error}>{live.lastError}</Text> : null}
                  </View>
                  <View style={styles.add}>
                    <Text style={styles.addText}>{live.installed ? "Added" : "Add"}</Text>
                  </View>
                </Pressable>
              );
            })}
        </View>
      ))}
      <PluginDetail
        plugin={selected ? rows.find((row) => row.id === selected.id) ?? selected : null}
        onClose={() => setSelected(null)}
        onAdd={(id) => {
          onAdd(id);
        }}
        onRemove={(id) => {
          onRemove(id);
          setSelected(null);
        }}
      />
    </ScrollView>
  );
}

/**
 * Adds a public MCP URL for this account only.
 * Input: save and sign-in handlers.
 * Output: the custom plugin form.
 */
export function CustomPluginPage({
  onSave,
  onSignIn,
  scrollStyle,
}: {
  onSave: (name: string, url: string, secret: string) => void;
  onSignIn: (name: string, url: string) => void;
  scrollStyle: ViewStyle;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const ready = name.trim().length > 0 && url.trim().length > 0;
  return (
    <ScrollView style={scrollStyle} contentInsetAdjustmentBehavior="automatic" nestedScrollEnabled contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <Text style={styles.description}>Paste a public HTTPS MCP URL. The token stays on this account's computer.</Text>
      <TextInput value={name} onChangeText={setName} placeholder="Name" placeholderTextColor={colors.muted} autoCapitalize="none" keyboardAppearance="dark" style={styles.input} />
      <TextInput value={url} onChangeText={setUrl} placeholder="https://example.com/mcp" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} keyboardAppearance="dark" style={styles.input} />
      <TextInput value={secret} onChangeText={setSecret} placeholder="Bearer token, if the server uses one" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} secureTextEntry keyboardAppearance="dark" style={styles.input} />
      <PrimaryButton label="Add" disabled={!ready} onPress={() => onSave(name, url, secret)} />
      <PrimaryButton label="Sign in" variant="secondary" disabled={!ready} onPress={() => onSignIn(name, url)} />
    </ScrollView>
  );
}

/**
 * Plugin detail. iOS uses a page sheet; Android uses a full-screen page.
 * Input: the selected plugin. Output: description, bundled skills, and Add.
 */
function PluginDetail({
  plugin,
  onClose,
  onAdd,
  onRemove,
}: {
  plugin: PluginCard | null;
  onClose: () => void;
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const skills = plugin?.skills ?? [];
  const skillLabel = skills.length === 1 ? "1 skill" : `${skills.length} skills`;
  const insets = useSafeAreaInsets();
  const pageSheet = process.env.EXPO_OS === "ios";
  return (
    <Modal visible={plugin !== null} animationType="slide" presentationStyle={pageSheet ? "pageSheet" : "fullScreen"} onRequestClose={onClose}>
      {plugin ? (
        <View style={[styles.detail, pageSheet ? null : { paddingTop: insets.top + 8, paddingBottom: Math.max(28, insets.bottom + 12) }]}>
          <CircleButton label="Close" onPress={onClose}>
            <IconClose />
          </CircleButton>
          <ScrollView style={styles.detailScrollView} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.detailScroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            <View style={styles.detailTitle}>
              <PluginGlyph mark={plugin.mark} name={plugin.name} large />
              <Text style={styles.detailName}>{plugin.name}</Text>
            </View>
            <Text style={styles.detailBody}>{plugin.description}</Text>
            <Text style={styles.section}>Includes</Text>
            <View style={styles.includeCard}>
              <Text style={styles.includeSummary}>1 connector{skills.length ? ` · ${skillLabel}` : ""}</Text>
              {skills.map((skill) => (
                <View key={skill.name} style={styles.skillRow}>
                  <Text style={styles.skillName}>{skill.name}</Text>
                  <Text style={styles.description} numberOfLines={2}>
                    {skill.description}
                  </Text>
                </View>
              ))}
            </View>
          </ScrollView>
          <Pressable
            accessibilityRole="button"
            onPress={() => (plugin.installed ? onRemove(plugin.id) : onAdd(plugin.id))}
            style={styles.detailAdd}
          >
            <Text style={styles.detailAddText}>{plugin.installed ? "Remove" : "Add"}</Text>
          </Pressable>
        </View>
      ) : null}
    </Modal>
  );
}

/** Shows the plugin icon, or the letter on its color when the icon is missing. */
function PluginGlyph({ mark, name, large }: { mark?: PluginCard["mark"]; name: string; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  const size = large ? styles.iconLarge : styles.icon;
  const letter = mark?.letter || name.trim().slice(0, 1).toUpperCase() || "?";
  const color = mark?.color || colors.control;
  if (mark?.icon && !failed) {
    return <Image source={{ uri: mark.icon }} style={size} onError={() => setFailed(true)} />;
  }
  return (
    <View style={[large ? styles.markLarge : styles.mark, { backgroundColor: color }]}>
      <Text style={styles.markText}>{letter}</Text>
    </View>
  );
}

export function pluginSlug(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(slug)) throw new Error("Use a name that starts with a letter.");
  return slug;
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
  scroll: { padding: 14, paddingBottom: 28, gap: 12 },
  header: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { color: colors.text, fontSize: 20, fontWeight: "600", flex: 1 },
  count: { backgroundColor: colors.card, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6 },
  countText: { color: colors.text, fontSize: 13 },
  search: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.card, borderRadius: 18, paddingHorizontal: 12, height: 44 },
  searchInput: { flex: 1, color: colors.text, fontSize: 16 },
  sectionBlock: { gap: 8 },
  section: { color: colors.muted, fontSize: 13, marginLeft: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.card, borderRadius: 16, padding: 12 },
  icon: { width: 40, height: 40, borderRadius: 12 },
  iconLarge: { width: 64, height: 64, borderRadius: 16 },
  mark: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  markLarge: { width: 64, height: 64, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  detail: { flex: 1, backgroundColor: colors.sheet, padding: 16, paddingBottom: 28 },
  detailScrollView: { flex: 1 },
  detailScroll: { gap: 14, paddingBottom: 24 },
  detailTitle: { flexDirection: "row", alignItems: "center", gap: 14, marginTop: 12 },
  detailName: { color: colors.text, fontSize: 28, fontWeight: "700", flex: 1 },
  detailBody: { color: colors.text, fontSize: 16, lineHeight: 22 },
  includeCard: { backgroundColor: colors.card, borderRadius: 16, overflow: "hidden" },
  includeSummary: { color: colors.text, fontSize: 15, paddingHorizontal: 14, paddingVertical: 14 },
  skillRow: { gap: 4, paddingHorizontal: 14, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  skillName: { color: colors.text, fontSize: 15, fontWeight: "600" },
  detailAdd: { backgroundColor: colors.online, borderRadius: 24, height: 50, alignItems: "center", justifyContent: "center" },
  detailAddText: { color: "#fff", fontSize: 17, fontWeight: "700" },
  markText: { color: "#fff", fontWeight: "700" },
  body: { flex: 1, gap: 2 },
  name: { color: colors.text, fontSize: 16, fontWeight: "600" },
  description: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  error: { color: colors.danger, fontSize: 12 },
  add: { backgroundColor: colors.control, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8 },
  addText: { color: colors.text, fontSize: 14, fontWeight: "600" },
  input: { backgroundColor: colors.card, color: colors.text, borderRadius: 14, height: 48, paddingHorizontal: 14, fontSize: 16 },
  primary: { backgroundColor: colors.text, borderRadius: 22, height: 48, alignItems: "center", justifyContent: "center" },
  primaryText: { color: colors.bg, fontSize: 16, fontWeight: "600" },
  secondary: { backgroundColor: colors.card, borderRadius: 22, height: 48, alignItems: "center", justifyContent: "center" },
  disabled: { opacity: 0.4 },
});
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
