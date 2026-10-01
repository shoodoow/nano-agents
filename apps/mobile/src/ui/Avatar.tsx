import { Image } from "expo-image";
import { View } from "react-native";
import { palette } from "../theme/tokens";
import { MARK_SHAPES, Mark, type MarkShape } from "./Mark";

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
 * Input: the agent id, the pixel size, circle vs squircle, the person flag,
 * and the saved mark (shape id, hex color, photo URL — all nullable).
 * Output: the uploaded photo, the saved character mark, or the legacy
 * hash-colored face when the agent never customized its mark.
 */
export function Avatar({
  id,
  size,
  round = false,
  person = false,
  shape = null,
  color = null,
  photo = null,
}: {
  id: string;
  size: number;
  round?: boolean;
  person?: boolean;
  shape?: string | null;
  color?: string | null;
  photo?: string | null;
}) {
  if (!person && photo) {
    return (
      <Image
        source={{ uri: photo }}
        contentFit="cover"
        style={{ width: size, height: size, borderRadius: round ? size / 2 : size * 0.32 }}
      />
    );
  }
  if (!person && (shape ?? color)) {
    const known = MARK_SHAPES.some((entry) => entry.id === shape);
    return <Mark shape={known ? (shape as MarkShape) : "square"} color={color ?? colorFor(id)} size={size * 0.72} />;
  }
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
