import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import type { ProviderSetting, RosterAgent } from "../api";
import { colors } from "../theme/tokens";
import { CircleButton } from "../ui/CircleButton";
import { IconBack } from "../ui/icons";

/**
 * Edits one agent's name, label, role, personality, job, model provider, and roster flags.
 * Why: three identity fields replace the old blob — the phone manages them directly.
 * Input: the profile draft, configured providers, and the save and back handlers.
 * Output: the profile form.
 */
export function ProfileScreen({
  profile,
  providers,
  onChange,
  onSave,
  onBack,
}: {
  profile: RosterAgent;
  providers: ProviderSetting[];
  onChange: (profile: RosterAgent) => void;
  onSave: () => void;
  onBack: () => void;
}) {
  const configured = providers.filter((row) => row.configured);
  const providerChoices: ProviderSetting["provider"][] = [
    ...new Set([
      ...configured.map((row) => row.provider),
      ...(profile.provider ? [profile.provider] : []),
    ]),
  ];
  const saveReady =
    profile.modelId.trim().length > 0 &&
    providerChoices.length > 0 &&
    configured.some((row) => row.provider === profile.provider);

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <CircleButton label="Back" onPress={onBack}>
          <IconBack />
        </CircleButton>
        <Text style={styles.title}>Profile</Text>
        <View style={styles.spacer} />
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.form}>
        <Field label="Name" value={profile.name} onChangeText={(name) => onChange({ ...profile, name })} />
        <Field label="Label" value={profile.label} onChangeText={(label) => onChange({ ...profile, label })} />
        <Field label="Role" value={profile.role} onChangeText={(role) => onChange({ ...profile, role })} />
        <Field
          label="Personality"
          value={profile.personality}
          onChangeText={(personality) => onChange({ ...profile, personality })}
        />
        <Field label="Job" value={profile.jobDescription} onChangeText={(jobDescription) => onChange({ ...profile, jobDescription })} />
        <Text style={styles.label}>Provider</Text>
        <View style={styles.kinds}>
          {providerChoices.map((name) => (
            <Pressable
              key={name}
              accessibilityRole="button"
              onPress={() => onChange({ ...profile, provider: name })}
              style={[styles.kind, profile.provider === name && styles.kindOn]}
            >
              <Text style={[styles.kindText, profile.provider === name && styles.kindTextOn]}>{name}</Text>
            </Pressable>
          ))}
        </View>
        {configured.length === 0 ? <Text style={styles.hint}>Add an AI provider in the account menu first.</Text> : null}
        <Field
          label="Model id"
          value={profile.modelId}
          onChangeText={(modelId) => onChange({ ...profile, modelId })}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Flag label="Pin" value={profile.pinned} onChange={(pinned) => onChange({ ...profile, pinned })} />
        <Flag label="Hide" value={profile.hidden} onChange={(hidden) => onChange({ ...profile, hidden })} />
        <Flag label="Notify" value={profile.notify} onChange={(notify) => onChange({ ...profile, notify })} />
        <Pressable
          accessibilityRole="button"
          disabled={!saveReady}
          onPress={onSave}
          style={[styles.save, !saveReady && styles.saveDisabled]}
        >
          <Text style={styles.saveText}>Save profile</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

function Field({
  label,
  value,
  onChangeText,
  autoCapitalize,
  autoCorrect,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
  autoCorrect?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        keyboardAppearance="dark"
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
        style={styles.input}
      />
    </View>
  );
}

function Flag({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <View style={styles.flag}>
      <Text style={styles.label}>{label}</Text>
      <Switch value={value} onValueChange={onChange} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 16 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { color: colors.text, fontSize: 17, fontWeight: "600" },
  spacer: { width: 44 },
  form: { paddingBottom: 32 },
  field: { marginTop: 16 },
  label: { color: colors.text, fontSize: 15, marginBottom: 6 },
  input: { backgroundColor: colors.bubble, color: colors.text, borderRadius: 14, paddingHorizontal: 14, height: 44, fontSize: 16 },
  kinds: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  kind: { paddingHorizontal: 14, height: 40, borderRadius: 14, backgroundColor: colors.bubble, alignItems: "center", justifyContent: "center" },
  kindOn: { backgroundColor: colors.text },
  kindText: { color: colors.text, fontSize: 15, fontWeight: "600" },
  kindTextOn: { color: colors.bg },
  hint: { color: colors.muted, fontSize: 14, marginTop: 8 },
  flag: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 16 },
  save: { marginTop: 28, backgroundColor: colors.text, borderRadius: 22, height: 44, alignItems: "center", justifyContent: "center" },
  saveDisabled: { opacity: 0.4 },
  saveText: { color: colors.bg, fontSize: 16, fontWeight: "600" },
});
