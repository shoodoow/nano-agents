import { useEffect, useState } from "react";
import { Image } from "expo-image";
import {
  Alert,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import type { ProviderSetting, RosterAgent, Routine, RoutineRun } from "../api";
import { formatLastRun, formatSchedule, routineTitle } from "../api";
import { colors } from "../theme/tokens";
import { CircleButton } from "../ui/CircleButton";
import { IconBack, IconCheck, IconChevron, IconClock, IconDoc, IconMore, IconShare } from "../ui/icons";
import { MARK_COLORS, MARK_DEFAULT, MARK_SHAPES, Mark, type MarkShape } from "../ui/Mark";

type Page = "info" | "instructions" | "provider" | "routine";
type Tab = "info" | "links" | "media" | "files";

const TABS: { id: Tab; label: string }[] = [
  { id: "info", label: "Info" },
  { id: "links", label: "Links" },
  { id: "media", label: "Media" },
  { id: "files", label: "Files" },
];

/**
 * Shows the bot info page from the Grok reference, opened by tapping the
 * agent name in chat. Why: name card, character mark, instructions,
 * routines, and notifications live here; provider/model/flags sit under
 * Advanced (the reference has no slot for them, but the phone needs them).
 * Input: the editable profile draft, providers, routines, and actions.
 * Output: the info page with instructions / provider / routine sub-pages.
 * The mark shape, color, and photo save with the profile, so reopening
 * the page shows exactly what was picked.
 */
export function BotInfoScreen({
  profile,
  providers,
  routines,
  onChange,
  onSave,
  onSaveNotify,
  onBack,
  onApprovals,
  onPickAvatar,
  onPauseRoutine,
  onLoadRoutineRuns,
}: {
  profile: RosterAgent;
  providers: ProviderSetting[];
  routines: Routine[];
  onChange: (profile: RosterAgent) => void;
  onSave: () => void;
  onSaveNotify: (profile: RosterAgent) => void;
  onBack: () => void;
  onApprovals: () => void;
  onPickAvatar: () => void;
  onPauseRoutine: (routine: Routine, paused: boolean) => void;
  onLoadRoutineRuns: (routineId: string) => Promise<RoutineRun[]>;
}) {
  const [page, setPage] = useState<Page>("info");
  const [tab, setTab] = useState<Tab>("info");
  const [mark, setMark] = useState(() => initialMark(profile));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = routines.find((row) => row.id === selectedId) ?? null;

  /** Stages one mark pick in the preview and the profile draft. */
  function pickMark(next: { shape: MarkShape; color: string }): void {
    setMark(next);
    onChange({ ...profile, markShape: next.shape, markColor: next.color });
  }

  /** Restores the default mark and clears the photo. */
  function resetMark(): void {
    setMark(MARK_DEFAULT);
    onChange({ ...profile, markShape: MARK_DEFAULT.shape, markColor: MARK_DEFAULT.color, avatarUrl: null });
  }

  function share(): void {
    void Share.share({ message: `${profile.name} — ${profile.role}` }).catch(() => {});
  }

  function more(): void {
    Alert.alert(profile.name, undefined, [
      { text: "Approvals", onPress: onApprovals },
      { text: "Cancel", style: "cancel" },
    ]);
  }

  if (page === "instructions") {
    return (
      <InstructionsPage
        profile={profile}
        onChange={onChange}
        onSave={onSave}
        onBack={() => setPage("info")}
      />
    );
  }
  if (page === "provider") {
    return (
      <ProviderPage
        profile={profile}
        providers={providers}
        onSelect={(provider) => {
          onChange({ ...profile, provider });
          setPage("info");
        }}
        onBack={() => setPage("info")}
      />
    );
  }
  if (page === "routine" && selected) {
    return (
      <RoutineDetailPage
        routine={selected}
        onPause={(paused) => onPauseRoutine(selected, paused)}
        onLoadRuns={() => onLoadRoutineRuns(selected.id)}
        onBack={() => setPage("info")}
      />
    );
  }
  return (
    <InfoPage
      profile={profile}
      providers={providers}
      routines={routines}
      mark={mark}
      tab={tab}
      onTab={setTab}
      onPickMark={pickMark}
      onResetMark={resetMark}
      onPickAvatar={onPickAvatar}
      onChange={onChange}
      onSave={onSave}
      onSaveNotify={onSaveNotify}
      onBack={onBack}
      onShare={share}
      onMore={more}
      onInstructions={() => setPage("instructions")}
      onProvider={() => setPage("provider")}
      onRoutine={(routine) => {
        setSelectedId(routine.id);
        setPage("routine");
      }}
    />
  );
}

/** Reads the saved mark, falling back to the default for legacy agents. */
function initialMark(profile: RosterAgent): { shape: MarkShape; color: string } {
  const shape = MARK_SHAPES.some((entry) => entry.id === profile.markShape) ? (profile.markShape as MarkShape) : MARK_DEFAULT.shape;
  return { shape, color: profile.markColor ?? MARK_DEFAULT.color };
}

/**
 * Shows the Info tab: mark, name card, tabs, character, instructions,
 * routines, notifications, and advanced model flags.
 */
function InfoPage({
  profile,
  providers,
  routines,
  mark,
  tab,
  onTab,
  onPickMark,
  onResetMark,
  onPickAvatar,
  onChange,
  onSave,
  onSaveNotify,
  onBack,
  onShare,
  onMore,
  onInstructions,
  onProvider,
  onRoutine,
}: {
  profile: RosterAgent;
  providers: ProviderSetting[];
  routines: Routine[];
  mark: { shape: MarkShape; color: string };
  tab: Tab;
  onTab: (tab: Tab) => void;
  onPickMark: (mark: { shape: MarkShape; color: string }) => void;
  onResetMark: () => void;
  onPickAvatar: () => void;
  onChange: (profile: RosterAgent) => void;
  onSave: () => void;
  onSaveNotify: (profile: RosterAgent) => void;
  onBack: () => void;
  onShare: () => void;
  onMore: () => void;
  onInstructions: () => void;
  onProvider: () => void;
  onRoutine: (routine: Routine) => void;
}) {
  const configured = providers.filter((row) => row.configured);
  const providerChoices: ProviderSetting["provider"][] = [
    ...new Set([...configured.map((row) => row.provider), ...(profile.provider ? [profile.provider] : [])]),
  ];
  const saveReady =
    profile.modelId.trim().length > 0 &&
    providerChoices.length > 0 &&
    configured.some((row) => row.provider === profile.provider);
  const providerName = profile.provider === "xai" ? "xAI" : profile.provider[0]?.toUpperCase() + profile.provider.slice(1);
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <CircleButton label="Back" onPress={onBack}>
          <IconBack />
        </CircleButton>
        <View style={styles.headerRight}>
          <CircleButton label="Share bot" onPress={onShare}>
            <IconShare />
          </CircleButton>
          <CircleButton label="More" onPress={onMore}>
            <IconMore />
          </CircleButton>
        </View>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="Change bot photo" onPress={onPickAvatar} style={styles.markWrap}>
        {profile.avatarUrl ? (
          <Image source={{ uri: profile.avatarUrl }} contentFit="cover" style={styles.markPhoto} />
        ) : (
          <Mark shape={mark.shape} color={mark.color} size={112} />
        )}
      </Pressable>
      <View style={styles.nameCard}>
        <TextInput
          value={profile.name}
          onChangeText={(name) => onChange({ ...profile, name })}
          keyboardAppearance="dark"
          style={styles.nameInput}
        />
        <View style={styles.nameDivider} />
        <TextInput
          value={profile.label}
          onChangeText={(label) => onChange({ ...profile, label })}
          placeholder="Title (optional)"
          placeholderTextColor={colors.muted}
          keyboardAppearance="dark"
          style={styles.titleInput}
        />
      </View>
      <View style={styles.tabs}>
        {TABS.map((entry) => (
          <Pressable
            key={entry.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === entry.id }}
            onPress={() => onTab(entry.id)}
            style={styles.tab}
          >
            <Text style={[styles.tabText, tab === entry.id ? styles.tabTextOn : null]}>{entry.label}</Text>
            {tab === entry.id ? <View style={styles.tabBar} /> : null}
          </Pressable>
        ))}
      </View>
      {tab !== "info" ? (
        <TabEmpty tab={tab} />
      ) : (
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          <Text style={styles.section}>Character</Text>
          <View style={styles.card}>
            <View style={styles.shapeGrid}>
              {MARK_SHAPES.map((entry) => (
                <Pressable
                  key={entry.id}
                  accessibilityRole="button"
                  accessibilityLabel={entry.label}
                  accessibilityState={{ selected: mark.shape === entry.id }}
                  onPress={() => onPickMark({ ...mark, shape: entry.id })}
                  style={styles.shapeCell}
                >
                  <View style={[styles.ring, mark.shape === entry.id ? styles.ringOn : null]}>
                    <Mark shape={entry.id} color={mark.color} size={40} />
                  </View>
                </Pressable>
              ))}
            </View>
            <View style={styles.colorGrid}>
              {MARK_COLORS.map((color) => (
                <Pressable
                  key={color}
                  accessibilityRole="button"
                  accessibilityLabel={`Mark color ${color}`}
                  accessibilityState={{ selected: mark.color === color }}
                  onPress={() => onPickMark({ ...mark, color })}
                  style={styles.colorCell}
                >
                  <View style={[styles.ring, mark.color === color ? styles.ringOn : null]}>
                    <View style={[styles.dot, { backgroundColor: color }]} />
                  </View>
                </Pressable>
              ))}
            </View>
            <View style={styles.resetDivider} />
            <Pressable accessibilityRole="button" onPress={onResetMark} style={styles.resetRow}>
              <Text style={styles.resetText}>Reset to default</Text>
            </Pressable>
          </View>
          <Text style={styles.caption}>How this Bot's mark looks everywhere</Text>
          <Pressable accessibilityRole="button" onPress={onInstructions} style={styles.rowCard}>
            <IconDoc />
            <Text style={styles.rowLabel}>Instructions</Text>
            <IconChevron />
          </Pressable>
          <Text style={styles.section}>Routines</Text>
          <View style={styles.group}>
            {routines.length === 0 ? (
              <View style={styles.emptyRow}>
                <Text style={styles.emptyText}>No routines yet — this bot adds them with its tools.</Text>
              </View>
            ) : null}
            {routines.map((routine) => (
              <Pressable
                key={routine.id}
                accessibilityRole="button"
                onPress={() => onRoutine(routine)}
                style={styles.routineRow}
              >
                <IconClock />
                <View style={styles.routineBody}>
                  <Text style={styles.routineTitle} numberOfLines={1}>
                    {routineTitle(routine.body)}
                  </Text>
                  <Text style={styles.routineSub} numberOfLines={1}>
                    {formatSchedule(routine.cron)}
                    {routine.paused ? " · Paused" : ""}
                  </Text>
                  <Text
                    style={[
                      styles.routineSub,
                      routine.lastRunStatus === "failed" ? styles.routineFailed : null,
                    ]}
                    numberOfLines={1}
                  >
                    Last run · {formatLastRun(routine.lastRunAt, routine.lastRunStatus, routine.timezone)}
                  </Text>
                </View>
                <IconChevron />
              </Pressable>
            ))}
          </View>
          <View style={styles.notifyCard}>
            <Text style={styles.rowLabel}>Notifications</Text>
            <Switch
              value={profile.notify}
              onValueChange={(notify) => onSaveNotify({ ...profile, notify })}
              trackColor={{ true: colors.green, false: colors.line }}
            />
          </View>
          <Text style={styles.caption}>Get notified when this Bot finishes or needs input</Text>
          <Text style={styles.section}>Advanced</Text>
          <View style={styles.group}>
            <Pressable accessibilityRole="button" onPress={onProvider} style={styles.providerRow}>
              <Text style={styles.rowLabel}>Provider</Text>
              <View style={styles.trailing}>
                <Text style={styles.trailingText}>{providerName}</Text>
                <IconChevron />
              </View>
            </Pressable>
            <View style={styles.advancedBlock}>
              <Text style={styles.advancedLabel}>Model id</Text>
              <TextInput
                value={profile.modelId}
                onChangeText={(modelId) => onChange({ ...profile, modelId })}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardAppearance="dark"
                style={styles.input}
              />
            </View>
            <View style={styles.flagRow}>
              <Text style={styles.rowLabel}>Pin</Text>
              <Switch value={profile.pinned} onValueChange={(pinned) => onChange({ ...profile, pinned })} />
            </View>
            <View style={styles.flagRow}>
              <Text style={styles.rowLabel}>Hide</Text>
              <Switch value={profile.hidden} onValueChange={(hidden) => onChange({ ...profile, hidden })} />
            </View>
          </View>
          <Pressable
            accessibilityRole="button"
            disabled={!saveReady}
            onPress={onSave}
            style={[styles.save, !saveReady ? styles.saveDisabled : null]}
          >
            <Text style={styles.saveText}>Save changes</Text>
          </Pressable>
        </ScrollView>
      )}
    </View>
  );
}

/** Shows the empty state for tabs with no backend yet. */
function TabEmpty({ tab }: { tab: Tab }) {
  const copy =
    tab === "links"
      ? { title: "No links yet", hint: "Links this bot shares will appear here." }
      : tab === "media"
        ? { title: "No media yet", hint: "Photos and videos from this conversation will appear here." }
        : { title: "No files yet", hint: "Files from this conversation will appear here." };
  return (
    <View style={styles.tabEmpty}>
      <Text style={styles.tabEmptyTitle}>{copy.title}</Text>
      <Text style={styles.tabEmptyHint}>{copy.hint}</Text>
    </View>
  );
}

/**
 * Edits the three identity fields that shape the bot's behavior.
 * Input: the profile draft and actions. Output: the instructions form.
 */
function InstructionsPage({
  profile,
  onChange,
  onSave,
  onBack,
}: {
  profile: RosterAgent;
  onChange: (profile: RosterAgent) => void;
  onSave: () => void;
  onBack: () => void;
}) {
  return (
    <View style={styles.screen}>
      <View style={styles.pageHeader}>
        <CircleButton label="Back" onPress={onBack}>
          <IconBack />
        </CircleButton>
        <Text style={styles.pageTitle}>Instructions</Text>
        <View style={styles.spacer} />
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Text style={styles.fieldLabel}>Role</Text>
        <TextInput
          value={profile.role}
          onChangeText={(role) => onChange({ ...profile, role })}
          keyboardAppearance="dark"
          style={styles.input}
        />
        <Text style={styles.fieldLabel}>Personality</Text>
        <TextInput
          value={profile.personality}
          onChangeText={(personality) => onChange({ ...profile, personality })}
          keyboardAppearance="dark"
          multiline
          style={styles.area}
        />
        <Text style={styles.fieldLabel}>Job</Text>
        <TextInput
          value={profile.jobDescription}
          onChangeText={(jobDescription) => onChange({ ...profile, jobDescription })}
          keyboardAppearance="dark"
          multiline
          style={styles.area}
        />
        <Pressable accessibilityRole="button" onPress={onSave} style={styles.save}>
          <Text style={styles.saveText}>Save changes</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

/**
 * Picks the model provider as a dropdown page in the reference card style.
 * Input: the profile draft, providers, and actions. Output: the picker page.
 */
function ProviderPage({
  profile,
  providers,
  onSelect,
  onBack,
}: {
  profile: RosterAgent;
  providers: ProviderSetting[];
  onSelect: (provider: ProviderSetting["provider"]) => void;
  onBack: () => void;
}) {
  const configured = providers.filter((row) => row.configured);
  const choices: ProviderSetting["provider"][] = [
    ...new Set([...configured.map((row) => row.provider), ...(profile.provider ? [profile.provider] : [])]),
  ];
  return (
    <View style={styles.screen}>
      <View style={styles.pageHeader}>
        <CircleButton label="Back" onPress={onBack}>
          <IconBack />
        </CircleButton>
        <Text style={styles.pageTitle}>Provider</Text>
        <View style={styles.spacer} />
      </View>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.group}>
          {choices.map((name) => (
            <Pressable key={name} accessibilityRole="button" onPress={() => onSelect(name)} style={styles.providerChoice}>
              <Text style={styles.rowLabel}>{name === "xai" ? "xAI" : name[0]?.toUpperCase() + name.slice(1)}</Text>
              {configured.some((row) => row.provider === name) ? <Text style={styles.configured}>Configured</Text> : null}
              {profile.provider === name ? <IconCheck /> : null}
            </Pressable>
          ))}
        </View>
        {configured.length === 0 ? (
          <Text style={styles.caption}>Add an AI provider in the account menu first.</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

/**
 * Shows one routine: full standing order, schedule, next run, pause, and recent fires.
 * Why: detail must show the whole body (list rows stay truncated); delete stays
 * with the agent tools / Auto-review, not this screen.
 */
function RoutineDetailPage({
  routine,
  onPause,
  onLoadRuns,
  onBack,
}: {
  routine: Routine;
  onPause: (paused: boolean) => void;
  onLoadRuns: () => Promise<RoutineRun[]>;
  onBack: () => void;
}) {
  const [runs, setRuns] = useState<RoutineRun[]>(routine.recentRuns ?? []);
  useEffect(() => {
    setRuns(routine.recentRuns ?? []);
    let cancelled = false;
    void onLoadRuns()
      .then((next) => {
        if (!cancelled) setRuns(next);
      })
      .catch(() => {
        // Keep the list snapshot if refresh fails.
      });
    return () => {
      cancelled = true;
    };
    // Refresh when opening this routine; avoid looping on unstable callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routine.id]);
  return (
    <View style={styles.screen}>
      <View style={styles.pageHeader}>
        <CircleButton label="Back" onPress={onBack}>
          <IconBack />
        </CircleButton>
        <Text style={styles.pageTitle}>Routine</Text>
        <View style={styles.spacer} />
      </View>
      <ScrollView contentContainerStyle={styles.routineScroll} showsVerticalScrollIndicator={false}>
        <View style={styles.routineHero}>
          <View style={styles.routineHeroIcon}>
            <IconClock />
          </View>
          <Text style={styles.routineSchedule}>{formatSchedule(routine.cron)}</Text>
          {routine.paused ? <Text style={styles.routinePausedBadge}>Paused</Text> : null}
        </View>

        <Text style={styles.routineSection}>Standing order</Text>
        <View style={styles.card}>
          <Text style={styles.routineFullBody} selectable>
            {routine.body.trim()}
          </Text>
        </View>

        <Text style={styles.routineSection}>Schedule</Text>
        <View style={styles.card}>
          <View style={styles.metaRow}>
            <Text style={styles.metaLabel}>Next run</Text>
            <Text style={styles.metaValue}>
              {routine.paused ? "—" : formatNextRun(routine.nextRunAt, routine.timezone)}
            </Text>
          </View>
          <View style={styles.metaRow}>
            <Text style={styles.metaLabel}>Timezone</Text>
            <Text style={styles.metaValue}>{routine.timezone}</Text>
          </View>
          <View style={[styles.metaRow, styles.metaRowLast]}>
            <View style={styles.cardBody}>
              <Text style={styles.rowLabel}>Paused</Text>
              <Text style={styles.hint}>Paused routines never fire.</Text>
            </View>
            <Switch
              value={routine.paused}
              onValueChange={onPause}
              trackColor={{ true: colors.green, false: colors.line }}
            />
          </View>
        </View>

        <Text style={styles.routineSection}>Recent runs</Text>
        <View style={styles.card}>
          {runs.length === 0 ? (
            <Text style={styles.hint}>No finished runs yet.</Text>
          ) : (
            runs.map((run, index) => (
              <View
                key={run.id}
                style={[styles.runRow, index === runs.length - 1 ? styles.runRowLast : null]}
              >
                <View
                  style={[
                    styles.runDot,
                    run.status === "failed" ? styles.runDotFail : styles.runDotOk,
                  ]}
                />
                <Text
                  style={[
                    styles.runStatus,
                    run.status === "failed" ? styles.routineFailed : styles.runOk,
                  ]}
                >
                  {run.status === "failed" ? "Failed" : "Completed"}
                </Text>
                <Text style={styles.runWhen}>{formatNextRun(run.runAt, routine.timezone)}</Text>
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </View>
  );
}

/** Words one ISO instant in the routine's zone. Output: "Fri, Jan 16, 9:32 AM". */
function formatNextRun(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone,
    }).format(date);
  } catch {
    return "—";
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 8, paddingTop: 4 },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  pageHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 8, paddingTop: 4 },
  pageTitle: { color: colors.text, fontSize: 17, fontWeight: "600" },
  spacer: { width: 44 },
  markWrap: { alignItems: "center", paddingTop: 8 },
  markPhoto: { width: 112, height: 106, borderRadius: 34, borderCurve: "continuous" },
  nameCard: { marginHorizontal: 48, marginTop: 16, backgroundColor: colors.bubble, borderRadius: 20, borderCurve: "continuous", paddingVertical: 6 },
  nameInput: { color: colors.text, fontSize: 22, fontWeight: "700", textAlign: "center", paddingVertical: 10, paddingHorizontal: 16 },
  nameDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginHorizontal: 16 },
  titleInput: { color: colors.text, fontSize: 16, textAlign: "center", paddingVertical: 12, paddingHorizontal: 16 },
  tabs: { flexDirection: "row", marginTop: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  tab: { flex: 1, alignItems: "center", paddingVertical: 10 },
  tabText: { color: "#666666", fontSize: 16 },
  tabTextOn: { color: colors.text },
  tabBar: { position: "absolute", bottom: 0, width: 64, height: 2, backgroundColor: colors.text },
  scroll: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 40, gap: 10 },
  section: { color: colors.muted, fontSize: 14, marginTop: 12, marginLeft: 6 },
  card: { backgroundColor: colors.bubble, borderRadius: 20, borderCurve: "continuous", padding: 16 },
  cardBody: { flex: 1, gap: 2 },
  shapeGrid: { flexDirection: "row", flexWrap: "wrap" },
  shapeCell: { width: "25%", alignItems: "center", paddingVertical: 10 },
  ring: { width: 66, height: 66, borderRadius: 33, borderWidth: 2, borderColor: "transparent", alignItems: "center", justifyContent: "center" },
  ringOn: { borderColor: "#6E6E73" },
  colorGrid: { flexDirection: "row", flexWrap: "wrap", marginTop: 4 },
  colorCell: { width: "16.66%", alignItems: "center", paddingVertical: 8 },
  dot: { width: 42, height: 42, borderRadius: 21 },
  resetDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginTop: 8 },
  resetRow: { paddingTop: 14 },
  resetText: { color: colors.link, fontSize: 17 },
  caption: { color: colors.muted, fontSize: 13, marginHorizontal: 6 },
  rowCard: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.bubble, borderRadius: 16, borderCurve: "continuous", paddingHorizontal: 16, paddingVertical: 16 },
  rowLabel: { color: colors.text, fontSize: 17, flex: 1 },
  hint: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  trailing: { flexDirection: "row", alignItems: "center", gap: 6 },
  trailingText: { color: colors.muted, fontSize: 16 },
  configured: { color: colors.green, fontSize: 13 },
  group: { backgroundColor: colors.bubble, borderRadius: 20, borderCurve: "continuous", overflow: "hidden" },
  routineRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  routineHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  routineBody: { flex: 1, gap: 2 },
  routineTitle: { color: colors.text, fontSize: 17 },
  routineSub: { color: colors.muted, fontSize: 14 },
  routineFailed: { color: colors.danger },
  routineScroll: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 48, gap: 8 },
  routineHero: { alignItems: "center", gap: 10, paddingVertical: 12 },
  routineHeroIcon: {
    width: 56,
    height: 56,
    borderRadius: 18,
    borderCurve: "continuous",
    backgroundColor: colors.bubble,
    alignItems: "center",
    justifyContent: "center",
  },
  routineSchedule: { color: colors.text, fontSize: 20, fontWeight: "700", textAlign: "center" },
  routinePausedBadge: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: "600",
    overflow: "hidden",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: colors.control,
  },
  routineSection: { color: colors.muted, fontSize: 13, fontWeight: "600", marginTop: 10, marginLeft: 4 },
  routineFullBody: { color: colors.text, fontSize: 16, lineHeight: 24 },
  metaRowLast: { paddingTop: 14, marginTop: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  runRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  runRowLast: { borderBottomWidth: 0, paddingBottom: 0 },
  runDot: { width: 8, height: 8, borderRadius: 4 },
  runDotOk: { backgroundColor: colors.green },
  runDotFail: { backgroundColor: colors.danger },
  runStatus: { fontSize: 15, fontWeight: "600", flex: 1 },
  runOk: { color: colors.text },
  runWhen: { color: colors.muted, fontSize: 14, flexShrink: 1, textAlign: "right" },
  emptyRow: { paddingHorizontal: 16, paddingVertical: 14 },
  emptyText: { color: colors.muted, fontSize: 14 },
  notifyCard: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.bubble, borderRadius: 20, borderCurve: "continuous", paddingHorizontal: 16, paddingVertical: 14 },
  providerRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  providerChoice: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  metaRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: 12 },
  metaLabel: { color: colors.muted, fontSize: 15 },
  metaValue: { color: colors.text, fontSize: 15 },
  detailsText: { color: colors.text, fontSize: 15, lineHeight: 22 },
  advancedBlock: { paddingHorizontal: 16, paddingTop: 14, gap: 8 },
  advancedLabel: { color: colors.text, fontSize: 15 },
  input: { backgroundColor: colors.control, color: colors.text, borderRadius: 14, borderCurve: "continuous", height: 48, paddingHorizontal: 14, fontSize: 16 },
  fieldLabel: { color: colors.text, fontSize: 15, marginTop: 16, marginBottom: 6 },
  area: { backgroundColor: colors.bubble, color: colors.text, borderRadius: 14, borderCurve: "continuous", minHeight: 110, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, textAlignVertical: "top" },
  flagRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12 },
  save: { marginTop: 24, backgroundColor: colors.text, borderRadius: 22, borderCurve: "continuous", height: 48, alignItems: "center", justifyContent: "center" },
  saveDisabled: { opacity: 0.4 },
  saveText: { color: colors.bg, fontSize: 16, fontWeight: "600" },
  tabEmpty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 48 },
  tabEmptyTitle: { color: colors.text, fontSize: 17, fontWeight: "600" },
  tabEmptyHint: { color: colors.muted, fontSize: 14, textAlign: "center" },
});
