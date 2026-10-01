import { StyleSheet, View } from "react-native";
import type { MarkShape } from "@nano-agents/shared";

export type { MarkShape };

export const MARK_SHAPES: { id: MarkShape; label: string }[] = [
  { id: "circle", label: "Circle" },
  { id: "blob", label: "Blob" },
  { id: "square", label: "Rounded square" },
  { id: "pill", label: "Pill" },
  { id: "triangle", label: "Triangle" },
  { id: "hexagon", label: "Hexagon" },
  { id: "cloud", label: "Cloud" },
  { id: "drop", label: "Drop" },
];

/** The eleven mark colors from the bot info reference, in picker order. */
export const MARK_COLORS = [
  "#FFFFFF",
  "#A67C52",
  "#FF3B30",
  "#FF7A00",
  "#FFB340",
  "#34C759",
  "#30D0C8",
  "#0A84FF",
  "#8B5CF6",
  "#FF2D92",
  "#8E8E93",
];

export const MARK_DEFAULT: { shape: MarkShape; color: string } = { shape: "square", color: "#8B5CF6" };

const INK = "#111111";

/**
 * Draws the bot's character mark: one of eight shapes with two slanted eyes.
 * Why: the bot info page previews the mark large and in the picker grid —
 * both render from the same shape + color. Input: shape, color, pixel size.
 * Output: the mark. Eyes sit lower on tall narrow shapes (triangle, drop).
 */
export function Mark({ shape, color, size }: { shape: MarkShape; color: string; size: number }) {
  const eyeWidth = Math.max(3, size * 0.075);
  const eyeHeight = size * 0.21;
  const eyeGap = size * 0.13;
  const eyeDy = shape === "triangle" ? size * 0.16 : shape === "drop" ? size * 0.06 : 0;
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={`${shape} mark`}
      style={[styles.stage, { width: size * 1.4, height: size }]}
    >
      {body(shape, color, size)}
      <View pointerEvents="none" style={[styles.eyes, { marginTop: eyeDy }]}>
        <View style={{ width: eyeWidth, height: eyeHeight, borderRadius: eyeWidth / 2, backgroundColor: INK, transform: [{ rotate: "24deg" }] }} />
        <View style={{ width: eyeWidth, height: eyeHeight, borderRadius: eyeWidth / 2, backgroundColor: INK, transform: [{ rotate: "24deg" }], marginLeft: eyeGap }} />
      </View>
    </View>
  );
}

/** Draws the shape silhouette. Input: shape, color, size. Output: the body views. */
function body(shape: MarkShape, color: string, size: number) {
  switch (shape) {
    case "circle":
      return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
    case "blob":
      return <View style={{ width: size * 1.08, height: size * 0.92, borderRadius: size * 0.44, backgroundColor: color }} />;
    case "square":
      return <View style={{ width: size, height: size * 0.94, borderRadius: size * 0.3, backgroundColor: color }} />;
    case "pill":
      return <View style={{ width: size * 1.3, height: size * 0.68, borderRadius: size * 0.34, backgroundColor: color }} />;
    case "triangle":
      return (
        <View
          style={{
            width: 0,
            height: 0,
            borderLeftWidth: size * 0.48,
            borderRightWidth: size * 0.48,
            borderBottomWidth: size * 0.86,
            borderLeftColor: "transparent",
            borderRightColor: "transparent",
            borderBottomColor: color,
          }}
        />
      );
    case "hexagon":
      return (
        <View style={styles.hex}>
          <View
            style={{
              width: size * 0.52,
              borderLeftWidth: size * 0.24,
              borderRightWidth: size * 0.24,
              borderBottomWidth: size * 0.21,
              borderLeftColor: "transparent",
              borderRightColor: "transparent",
              borderBottomColor: color,
            }}
          />
          <View style={{ width: size, height: size * 0.5, backgroundColor: color }} />
          <View
            style={{
              width: size * 0.52,
              borderLeftWidth: size * 0.24,
              borderRightWidth: size * 0.24,
              borderTopWidth: size * 0.21,
              borderLeftColor: "transparent",
              borderRightColor: "transparent",
              borderTopColor: color,
            }}
          />
        </View>
      );
    case "cloud":
      return (
        <View style={{ width: size * 1.2, height: size * 0.9 }}>
          <View style={{ position: "absolute", left: 0, bottom: 0, width: size * 0.52, height: size * 0.52, borderRadius: size * 0.26, backgroundColor: color }} />
          <View style={{ position: "absolute", left: size * 0.27, top: 0, width: size * 0.66, height: size * 0.66, borderRadius: size * 0.33, backgroundColor: color }} />
          <View style={{ position: "absolute", right: 0, bottom: 0, width: size * 0.44, height: size * 0.44, borderRadius: size * 0.22, backgroundColor: color }} />
        </View>
      );
    case "drop":
      return (
        <View style={styles.drop}>
          <View
            style={{
              width: 0,
              height: 0,
              borderLeftWidth: size * 0.34,
              borderRightWidth: size * 0.34,
              borderBottomWidth: size * 0.4,
              borderLeftColor: "transparent",
              borderRightColor: "transparent",
              borderBottomColor: color,
            }}
          />
          <View style={{ width: size * 0.68, height: size * 0.68, borderRadius: size * 0.34, backgroundColor: color, marginTop: -size * 0.1 }} />
        </View>
      );
  }
}

const styles = StyleSheet.create({
  stage: { alignItems: "center", justifyContent: "center" },
  eyes: { position: "absolute", flexDirection: "row", alignItems: "center" },
  hex: { alignItems: "center" },
  drop: { alignItems: "center", justifyContent: "flex-end" },
});
