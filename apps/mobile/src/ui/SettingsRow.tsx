import type { ReactNode } from "react";
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { interaction } from "./pressableStyles";

/** List row with visible press highlight (settings / menu sheets). */
export function SettingsRow({
  onPress,
  children,
  style,
  disabled,
}: {
  onPress: () => void;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      android_ripple={{ color: "rgba(255,255,255,0.12)" }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        style,
        pressed && !disabled ? styles.rowPressed : null,
        disabled ? styles.rowDisabled : null,
      ]}
    >
      {children}
    </Pressable>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  rowPressed: { backgroundColor: interaction.rowPressedBackground },
  rowDisabled: { opacity: 0.38 },
});
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
