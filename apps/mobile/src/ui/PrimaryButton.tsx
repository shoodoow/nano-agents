import { ActivityIndicator, Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from "react-native";
import { colors } from "../theme/tokens";
import { pressableStyle } from "./pressableStyles";

/**
 * Full-width primary action with pressed, disabled, and busy states.
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
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  variant?: "primary" | "secondary" | "danger";
  style?: StyleProp<ViewStyle>;
}) {
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
      onPress={onPress}
      style={(state) => pressableStyle([shell, style], { ...state, disabled: off })}
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

const styles = StyleSheet.create({
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
