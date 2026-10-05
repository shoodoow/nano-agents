import type { ComponentProps } from "react";
import { Feather } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../theme/tokens";

type AttachAction = {
  icon: ComponentProps<typeof Feather>["name"];
  label: string;
  onPress: () => void;
};

/**
 * Floating attach menu anchored above the composer + button.
 * Why: matches native chat apps — dark glass card, icon + label rows.
 */
export function AttachMenu({ actions }: { actions: AttachAction[] }) {
  return (
    <View style={styles.menu}>
      {actions.map((action) => (
        <Pressable
          key={action.label}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          onPress={action.onPress}
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        >
          <Feather name={action.icon} size={20} color={colors.text} />
          <Text style={styles.label}>{action.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  menu: {
    backgroundColor: "rgba(44, 44, 46, 0.94)",
    borderRadius: 22,
    borderCurve: "continuous",
    paddingVertical: 6,
    minWidth: 220,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255, 255, 255, 0.08)",
    shadowColor: "#000",
    shadowOpacity: 0.45,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 16,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 13,
    paddingHorizontal: 18,
  },
  rowPressed: { backgroundColor: "rgba(255, 255, 255, 0.08)" },
  label: { color: colors.text, fontSize: 17, fontWeight: "400" },
});
