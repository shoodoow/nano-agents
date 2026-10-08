import { memo } from "react";
import { Image } from "expo-image";
import { Text, View } from "react-native";
import { isLiveMark } from "./DotStage";
import { LivingMark, Mark, resolveMarkLook, type MarkMood } from "./Mark";
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

/** First letters of the signed-in name, or a single mark when the name is empty. */
function initials(label?: string): string {
  const parts = (label ?? "").trim().split(/\s+/).filter(Boolean);
  const letters = parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return letters || "?";
}

type AvatarProps = {
  id: string;
  size: number;
  round?: boolean;
  person?: boolean;
  /** Signed-in name. The person badge shows initials from this. */
  label?: string;
  shape?: string | null;
  color?: string | null;
  material?: string | null;
  style?: string | null;
  gender?: string | null;
  photo?: string | null;
  mood?: MarkMood;
  alive?: boolean;
  interactive?: boolean;
};

function AvatarInner({
  id,
  size,
  round = false,
  person = false,
  label,
  shape = null,
  color = null,
  material = null,
  style = null,
  gender = null,
  photo = null,
  mood = "idle",
  alive = true,
}: AvatarProps) {
  if (!person && photo) {
    return (
      <Image
        source={{ uri: photo }}
        contentFit="cover"
        style={{ width: size, height: size, borderRadius: round ? size / 2 : size * 0.32 }}
      />
    );
  }
  if (!person) {
    const look = resolveMarkLook({
      markShape: shape,
      markColor: color,
      markMaterial: material,
      markStyle: style,
      markGender: gender,
    });
    const markSize = size * 0.72;
    const frame = { width: size, height: size, alignItems: "center" as const, justifyContent: "center" as const };
    if (alive && isLiveMark(size)) {
      return (
        <View style={frame}>
          <LivingMark
            shape={look.shape}
            color={look.color}
            material={look.material}
            style={look.style}
            gender={look.gender}
            size={markSize}
            mood={mood}
          />
        </View>
      );
    }
    return (
      <View style={frame}>
        <Mark
          shape={look.shape}
          color={look.color}
          material={look.material}
          style={look.style}
          gender={look.gender}
          size={markSize}
        />
      </View>
    );
  }
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: colorFor(id),
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ color: "#FFFFFF", fontSize: Math.max(12, Math.round(size * 0.38)), fontWeight: "600" }}>{initials(label)}</Text>
    </View>
  );
}

function avatarPropsEqual(left: AvatarProps, right: AvatarProps): boolean {
  return (
    left.size === right.size &&
    left.id === right.id &&
    left.round === right.round &&
    left.person === right.person &&
    left.label === right.label &&
    left.shape === right.shape &&
    left.color === right.color &&
    left.material === right.material &&
    left.style === right.style &&
    left.gender === right.gender &&
    left.photo === right.photo &&
    left.mood === right.mood &&
    left.alive === right.alive
  );
}

/**
 * Draws the roster / chat / mention avatar.
 * Why: one shared Dot bakery backs every small avatar (lists, bubbles, badges);
 * live WebGL is only for large hero sizes so scrolling stays fast.
 */
export const Avatar = memo(AvatarInner, avatarPropsEqual);
