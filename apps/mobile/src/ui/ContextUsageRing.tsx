import { View, StyleSheet } from "react-native";
import Svg, { Circle, G } from "react-native-svg";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";

const SIZE = 22;
const STROKE = 2.5;
const R = (SIZE - STROKE) / 2;
const C = 2 * Math.PI * R;
/** Tiny fills stay visible (matches header "<1%" without looking empty). */
const MIN_ARC = 3;

/**
 * Thin donut beside the chat composer — share of the model context window
 * this thread’s estimated turn occupies (same estTurnShare as the header line).
 */
export function ContextUsageRing({ share, hint }: { share: number; hint?: string | null }) {
  const clamped = Math.min(1, Math.max(0, share));
  const filled = clamped > 0 ? Math.max(clamped * C, MIN_ARC) : 0;
  const pctLabel =
    clamped <= 0 ? "0%" : clamped < 0.01 ? "under 1%" : `${Math.round(clamped * 100)}%`;
  const label =
    hint ?? `${pctLabel} of this model’s context window is in the current prompt estimate.`;
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      style={styles.wrap}
    >
      <Svg width={SIZE} height={SIZE}>
        <Circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={R}
          stroke="rgba(142, 142, 147, 0.35)"
          strokeWidth={STROKE}
          fill="none"
        />
        <G rotation={-90} origin={`${SIZE / 2}, ${SIZE / 2}`}>
          <Circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={R}
            stroke={clamped > 0 ? colors.link : "#8E8E93"}
            strokeWidth={STROKE}
            fill="none"
            strokeDasharray={`${filled} ${C}`}
            strokeLinecap="round"
          />
        </G>
      </Svg>
    </View>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
  wrap: {
    width: SIZE + 4,
    height: SIZE + 4,
    alignItems: "center",
    justifyContent: "center",
  },
});
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
