import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { colors } from "../theme/tokens";

/**
 * Renders one round chrome button.
 * Input: an accessibility label, a press handler, and the icon.
 * Output: a 44-point hit target with a dark circle.
 */
export function CircleButton({
  label,
  onPress,
  children,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.hit, pressed && styles.pressed]}
    >
      <View style={styles.circle}>{children}</View>
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
  pressed: { opacity: 0.55, transform: [{ scale: 0.96 }] },
});
