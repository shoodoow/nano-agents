import { View } from "react-native";
import { palette } from "../theme/tokens";

/**
 * Picks a stable face color for one agent.
 * Why: exported so chat name labels match avatar faces per author.
 * Input: the agent id.
 * Output: a hex color from the roster palette.
 */
export function colorFor(id: string): string {
  let hash = 0;
  for (const char of id) {
    hash = (hash + char.charCodeAt(0)) % palette.length;
  }
  return palette[hash] ?? palette[0];
}

/**
 * Draws the rounded face used on the roster and in chat.
 * Input: the agent id, the pixel size, and whether the face is a circle.
 * Output: a colored mark with two eyes.
 */
export function Avatar({ id, size, round = false, person = false }: { id: string; size: number; round?: boolean; person?: boolean }) {
  const backgroundColor = person ? "#3A3A3C" : colorFor(id);
  const ink = backgroundColor === "#F2F2F7" ? "#111111" : "#FFFFFF";
  if (person) {
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor,
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        <View style={{ width: size * 0.34, height: size * 0.34, borderRadius: size, backgroundColor: ink, marginTop: size * 0.08 }} />
        <View
          style={{
            width: size * 0.62,
            height: size * 0.34,
            borderTopLeftRadius: size,
            borderTopRightRadius: size,
            backgroundColor: ink,
            marginTop: size * 0.06,
          }}
        />
      </View>
    );
  }
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: round ? size / 2 : size * 0.32,
        backgroundColor,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View style={{ flexDirection: "row", gap: size * 0.14 }}>
        <View style={{ width: size * 0.075, height: size * 0.2, borderRadius: size, backgroundColor: ink }} />
        <View style={{ width: size * 0.075, height: size * 0.2, borderRadius: size, backgroundColor: ink }} />
      </View>
    </View>
  );
}
