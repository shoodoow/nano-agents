import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { colors } from "../theme/tokens";
import { pressableStyle } from "./pressableStyles";

/**
 * Renders one round chrome button.
 * Input: an accessibility label, a press handler, and the icon.
 * Output: a 44-point hit target with a dark circle.
 */
export function CircleButton({
  label,
  onPress,
  children,
  disabled,
  busy,
  active,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
  disabled?: boolean;
  busy?: boolean;
  /** Toggle-on highlight (search open, attach menu, etc.). */
  active?: boolean;
}) {
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy, selected: active }}
      disabled={off}
      onPress={onPress}
      style={(state) => pressableStyle(styles.hit, { ...state, disabled: off })}
    >
      <View style={[styles.circle, active ? styles.circleActive : null]}>
        {busy ? <ActivityIndicator color={colors.text} size="small" /> : children}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hit: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  circle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.control,
    alignItems: "center",
    justifyContent: "center",
  },
  circleActive: { backgroundColor: colors.line },
});
