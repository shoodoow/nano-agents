import { Image } from "expo-image";
import { View } from "react-native";
import { palette } from "../theme/tokens";
import { markShapes, type MarkShape } from "@nano-agents/shared";
import { LivingMark, Mark, type MarkMood } from "./Mark";

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
 * the saved mark, and optional living mood (idle/working).
 * Output: photo, living/static character mark, or legacy hash face.
 * Photos never get fake eyes; shape marks animate when alive (default on).
 */
export function Avatar({
  id,
  size,
  round = false,
  person = false,
  shape = null,
  color = null,
  photo = null,
  mood = "idle",
  alive = true,
  interactive = false,
}: {
  id: string;
  size: number;
  round?: boolean;
  person?: boolean;
  shape?: string | null;
  color?: string | null;
  photo?: string | null;
  mood?: MarkMood;
  alive?: boolean;
  interactive?: boolean;
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
    const known = markShapes.includes(shape as MarkShape);
    const markShape = known ? (shape as MarkShape) : "square";
    const markColor = color ?? colorFor(id);
    const markSize = size * 0.72;
    if (alive) {
      return (
        <LivingMark
          shape={markShape}
          color={markColor}
          size={markSize}
          mood={mood}
          interactive={interactive}
        />
      );
    }
    return <Mark shape={markShape} color={markColor} size={markSize} />;
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
