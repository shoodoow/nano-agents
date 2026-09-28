import { Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import type { RosterAgent } from "../api";
import { colors } from "../theme/tokens";
import { CircleButton } from "../ui/CircleButton";
import { IconBack } from "../ui/icons";

/**
 * Edits one agent's name, label, description, and roster flags.
 * Input: the profile draft and the save and back handlers.
 * Output: the profile form.
 */
export function ProfileScreen({
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
      <View style={styles.header}>
        <CircleButton label="Back" onPress={onBack}>
          <IconBack />
        </CircleButton>
        <Text style={styles.title}>Profile</Text>
        <View style={styles.spacer} />
      </View>
      <Field label="Name" value={profile.name} onChangeText={(name) => onChange({ ...profile, name })} />
      <Field label="Label" value={profile.label} onChangeText={(label) => onChange({ ...profile, label })} />
      <Field label="Description" value={profile.description} onChangeText={(description) => onChange({ ...profile, description })} />
      <Flag label="Pin" value={profile.pinned} onChange={(pinned) => onChange({ ...profile, pinned })} />
      <Flag label="Hide" value={profile.hidden} onChange={(hidden) => onChange({ ...profile, hidden })} />
      <Flag label="Notify" value={profile.notify} onChange={(notify) => onChange({ ...profile, notify })} />
      <Pressable accessibilityRole="button" onPress={onSave} style={styles.save}>
        <Text style={styles.saveText}>Save profile</Text>
      </Pressable>
    </View>
  );
}

function Field({ label, value, onChangeText }: { label: string; value: string; onChangeText: (value: string) => void }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput value={value} onChangeText={onChangeText} keyboardAppearance="dark" style={styles.input} />
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
  field: { marginTop: 16 },
  label: { color: colors.text, fontSize: 15, marginBottom: 6 },
  input: { backgroundColor: colors.bubble, color: colors.text, borderRadius: 14, paddingHorizontal: 14, height: 44, fontSize: 16 },
  flag: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 16 },
  save: { marginTop: 28, backgroundColor: colors.text, borderRadius: 22, height: 44, alignItems: "center", justifyContent: "center" },
  saveText: { color: colors.bg, fontSize: 16, fontWeight: "600" },
});
