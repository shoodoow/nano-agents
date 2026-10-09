import { View, Text } from "react-native";
import { Avatar } from "./Avatar";
import { colors } from "../theme/tokens";

export type GroupFace = {
  id: string;
  markShape?: string | null;
  markColor?: string | null;
  markMaterial?: string | null;
  markStyle?: string | null;
  markGender?: string | null;
  avatarUrl?: string | null;
};

const MAX_FACES = 3;
const RING = 2;

/**
 * Draws a group as an avatar stack: equal circles in a row, each overlapping
 * the one before, with a "+N" circle for the members that do not fit.
 * Why: the old pile used three different sizes at three heights, which read
 * as clutter at list size. Same-size faces on one line with a ring in the
 * page color between them is the pattern people know (shadcn's AvatarGroup).
 * Input: members and the pixel size of one face. Output: the stack.
 */
export function GroupCluster({ members, size = 56 }: { members: GroupFace[]; size?: number }) {
  const shown = members.slice(0, MAX_FACES);
  const extra = members.length - shown.length;
  const overlap = -Math.round(size * 0.3);
  const circle = {
    width: size,
    height: size,
    borderRadius: size / 2,
    borderWidth: RING,
    borderColor: colors.bg,
    backgroundColor: colors.control,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    overflow: "hidden" as const,
  };
  return (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      {shown.map((member, index) => (
        <View key={member.id} style={[circle, index > 0 ? { marginLeft: overlap } : null]}>
          <Face member={member} size={size - RING * 2} />
        </View>
      ))}
      {extra > 0 ? (
        <View style={[circle, { marginLeft: overlap }]}>
          <Text style={{ color: colors.muted, fontSize: Math.round(size * 0.32), fontWeight: "600" }}>+{extra}</Text>
        </View>
      ) : null}
    </View>
  );
}

function Face({ member, size }: { member: GroupFace; size: number }) {
  return (
    <Avatar
      id={member.id}
      size={size}
      round
      shape={member.markShape}
      color={member.markColor}
      material={member.markMaterial}
      style={member.markStyle}
      gender={member.markGender}
      photo={member.avatarUrl}
    />
  );
}
