import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from "react-native";
import * as Haptics from "expo-haptics";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { pressableStyle } from "./pressableStyles";

/**
 * Full-width primary action with pressed, disabled, and busy states.
 * When onPress returns a promise (a save), the button shows a spinner and
 * ignores taps until it settles, so the press visibly does something.
 */
export function PrimaryButton({
  label,
  onPress,
  disabled,
  busy,
  variant = "primary",
  style,
}: {
  label: string;
  onPress: () => void | Promise<unknown>;
  disabled?: boolean;
  busy?: boolean;
  variant?: "primary" | "secondary" | "danger";
  style?: StyleProp<ViewStyle>;
}) {
  const [working, setWorking] = useState(false);
  busy = busy || working;
  const off = disabled || busy;
  const shell =
    variant === "secondary" ? styles.secondary : variant === "danger" ? styles.danger : styles.primary;
  const labelStyle =
    variant === "secondary" ? styles.secondaryText : variant === "danger" ? styles.dangerText : styles.primaryText;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy }}
      disabled={off}
      onPress={() => {
        if (process.env.EXPO_OS === "ios") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        const result = onPress();
        if (result instanceof Promise) {
          setWorking(true);
          void result.catch(() => {}).finally(() => setWorking(false));
        }
      }}
      style={(state) => pressableStyle([shell, style], { ...state, disabled: off && !busy })}
    >
      {busy ? (
        <ActivityIndicator color={variant === "secondary" ? colors.text : colors.bg} />
      ) : (
        <Text style={labelStyle}>{label}</Text>
      )}
    </Pressable>
  );
}

/** Compact pill for toolbars (e.g. Send). */
export function PillButton({
  label,
  onPress,
  disabled,
  busy,
  tone = "accent",
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  tone?: "accent" | "muted";
}) {
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: off, busy }}
      disabled={off}
      onPress={onPress}
      style={(state) =>
        pressableStyle([styles.pill, tone === "accent" ? styles.pillAccent : styles.pillMuted], {
          ...state,
          disabled: off,
        })
      }
    >
      {busy ? (
        <ActivityIndicator color="#fff" size="small" />
      ) : (
        <Text style={styles.pillText}>{label}</Text>
      )}
    </Pressable>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
  primary: {
    backgroundColor: colors.text,
    borderRadius: 22,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryText: { color: colors.bg, fontSize: 16, fontWeight: "600" },
  secondary: {
    backgroundColor: colors.card,
    borderRadius: 22,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  secondaryText: { color: colors.text, fontSize: 16, fontWeight: "600" },
  danger: {
    backgroundColor: colors.card,
    borderRadius: 22,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  dangerText: { color: colors.danger, fontSize: 16, fontWeight: "600" },
  pill: {
    minWidth: 64,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  pillAccent: { backgroundColor: colors.link },
  pillMuted: { backgroundColor: colors.control },
  pillText: { color: "#fff", fontSize: 16, fontWeight: "700" },
});
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
