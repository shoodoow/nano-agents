import { View, Text } from "react-native";
import { Avatar } from "./Avatar";
import { Mark, resolveMarkLook } from "./Mark";

export type GroupFace = {
  id: string;
  markShape?: string | null;
  markColor?: string | null;
  markMaterial?: string | null;
  markStyle?: string | null;
  markGender?: string | null;
  avatarUrl?: string | null;
};

/**
 * Draws the overlapping member marks used for a group.
 * Why: a group is a pile of faces plus a +N count, not one agent's avatar.
 * Input: members and the pixel height of the pile. Output: the cluster.
 */
export function GroupCluster({ members, size = 56 }: { members: GroupFace[]; size?: number }) {
  const shown = members.slice(0, 3);
  const extra = Math.max(0, members.length - shown.length);
  const slots = [
    { scale: 0.62, x: 0, y: 0.28, z: 1 },
    { scale: 0.86, x: 0.42, y: 0, z: 3 },
    { scale: 0.58, x: 0.92, y: 0.34, z: 2 },
  ];
  return (
    <View style={{ width: size * 2.15 + (extra > 0 ? size * 0.7 : 0), height: size }}>
      {shown.map((member, index) => {
        const slot = slots[index] ?? slots[0]!;
        const face = Math.round(size * slot.scale);
        return (
          <View
            key={member.id}
            style={{ position: "absolute", left: size * slot.x, top: size * slot.y, zIndex: slot.z }}
          >
            <Face member={member} size={face} />
          </View>
        );
      })}
      {extra > 0 ? (
        <Text
          style={{
            position: "absolute",
            left: size * 1.55,
            top: size * 0.28,
            color: "#8E8E93",
            fontSize: Math.round(size * 0.34),
            fontWeight: "700",
          }}
        >
          +{extra}
        </Text>
      ) : null}
    </View>
  );
}

function Face({ member, size }: { member: GroupFace; size: number }) {
  if (member.avatarUrl) {
    return <Avatar id={member.id} size={size} photo={member.avatarUrl} alive={false} />;
  }
  const look = resolveMarkLook({ ...member, markColor: member.markColor || "#FFCC38" });
  return (
    <Mark
      shape={look.shape}
      color={look.color}
      material={look.material}
      style={look.style}
      gender={look.gender}
      size={size}
    />
  );
}
