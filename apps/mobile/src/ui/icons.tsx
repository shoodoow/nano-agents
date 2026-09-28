import { View } from "react-native";

/**
 * Draws one white icon used in the phone chrome.
 * Input: none.
 * Output: a 18-point glyph.
 */
export function IconSearch() {
  return (
    <View style={{ width: 16, height: 16 }}>
      <View style={{ width: 12, height: 12, borderRadius: 6, borderWidth: 1.6, borderColor: "#fff" }} />
      <View
        style={{
          position: "absolute",
          width: 6,
          height: 1.6,
          backgroundColor: "#fff",
          bottom: 1,
          right: 0,
          transform: [{ rotate: "45deg" }],
        }}
      />
    </View>
  );
}

/** Draws a plus. Input: none. Output: a plus glyph. */
export function IconPlus() {
  return (
    <View style={{ width: 16, height: 16, alignItems: "center", justifyContent: "center" }}>
      <View style={{ position: "absolute", width: 14, height: 1.8, backgroundColor: "#fff" }} />
      <View style={{ position: "absolute", width: 1.8, height: 14, backgroundColor: "#fff" }} />
    </View>
  );
}

/** Draws a back chevron. Input: none. Output: a left chevron. */
export function IconBack() {
  return (
    <View
      style={{
        width: 10,
        height: 10,
        borderLeftWidth: 2,
        borderBottomWidth: 2,
        borderColor: "#fff",
        transform: [{ rotate: "45deg" }],
        marginLeft: 4,
      }}
    />
  );
}

/** Draws a desktop. Input: none. Output: a monitor glyph. */
export function IconMonitor() {
  return (
    <View style={{ width: 18, height: 16, alignItems: "center" }}>
      <View style={{ width: 18, height: 12, borderRadius: 2, borderWidth: 1.6, borderColor: "#fff" }} />
      <View style={{ width: 8, height: 1.6, backgroundColor: "#fff", marginTop: 2 }} />
    </View>
  );
}

/** Draws a microphone. Input: none. Output: a mic glyph. */
export function IconMic() {
  return (
    <View style={{ width: 12, height: 18, alignItems: "center" }}>
      <View style={{ width: 8, height: 12, borderRadius: 4, borderWidth: 1.6, borderColor: "#fff" }} />
      <View
        style={{
          position: "absolute",
          top: 6,
          width: 12,
          height: 8,
          borderBottomLeftRadius: 6,
          borderBottomRightRadius: 6,
          borderWidth: 1.6,
          borderTopWidth: 0,
          borderColor: "#fff",
        }}
      />
      <View style={{ width: 1.6, height: 4, backgroundColor: "#fff", marginTop: 1 }} />
    </View>
  );
}

/** Draws a voice waveform. Input: none. Output: four bars. */
export function IconWave() {
  const heights = [8, 14, 10, 16];
  return (
    <View style={{ width: 18, height: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
      {heights.map((height) => (
        <View key={height} style={{ width: 2, height, borderRadius: 1, backgroundColor: "#fff" }} />
      ))}
    </View>
  );
}

/** Draws a question mark. Input: none. Output: a question glyph. */
export function IconHelp() {
  return (
    <View style={{ width: 16, height: 16, alignItems: "center" }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, borderWidth: 1.6, borderColor: "#fff", borderBottomWidth: 0 }} />
      <View style={{ width: 1.6, height: 4, backgroundColor: "#fff", marginTop: -1 }} />
      <View style={{ width: 2, height: 2, borderRadius: 1, backgroundColor: "#fff", marginTop: 1 }} />
    </View>
  );
}

/** Draws an ellipsis. Input: none. Output: three dots. */
export function IconMore() {
  return (
    <View style={{ width: 16, height: 6, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
      {[0, 1, 2].map((dot) => (
        <View key={dot} style={{ width: 3, height: 3, borderRadius: 1.5, backgroundColor: "#fff" }} />
      ))}
    </View>
  );
}

/** Draws a clipboard. Input: none. Output: a clipboard glyph. */
export function IconClipboard() {
  return (
    <View style={{ width: 14, height: 16, alignItems: "center" }}>
      <View style={{ width: 6, height: 3, borderRadius: 1, borderWidth: 1.4, borderColor: "#fff", marginBottom: -1 }} />
      <View style={{ width: 14, height: 13, borderRadius: 2, borderWidth: 1.6, borderColor: "#fff" }} />
    </View>
  );
}

/** Draws a keyboard. Input: none. Output: a keyboard glyph. */
export function IconKeyboard() {
  return (
    <View style={{ width: 18, height: 12, borderRadius: 2, borderWidth: 1.6, borderColor: "#fff", padding: 1.5, justifyContent: "space-between" }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        {[0, 1, 2].map((key) => (
          <View key={key} style={{ width: 3, height: 2, backgroundColor: "#fff" }} />
        ))}
      </View>
      <View style={{ alignSelf: "center", width: 8, height: 2, backgroundColor: "#fff" }} />
    </View>
  );
}

/** Draws a close mark. Input: none. Output: an X glyph. */
export function IconClose() {
  return (
    <View style={{ width: 14, height: 14, alignItems: "center", justifyContent: "center" }}>
      <View style={{ position: "absolute", width: 14, height: 1.6, backgroundColor: "#fff", transform: [{ rotate: "45deg" }] }} />
      <View style={{ position: "absolute", width: 14, height: 1.6, backgroundColor: "#fff", transform: [{ rotate: "-45deg" }] }} />
    </View>
  );
}

/** Draws a right chevron. Input: none. Output: a right chevron. */
export function IconChevron() {
  return (
    <View
      style={{
        width: 8,
        height: 8,
        borderRightWidth: 1.6,
        borderTopWidth: 1.6,
        borderColor: "#8E8E93",
        transform: [{ rotate: "45deg" }],
      }}
    />
  );
}

/** Draws a check. Input: none. Output: a check glyph. */
export function IconCheck() {
  return (
    <View
      style={{
        width: 12,
        height: 7,
        borderLeftWidth: 1.8,
        borderBottomWidth: 1.8,
        borderColor: "#fff",
        transform: [{ rotate: "-45deg" }],
        marginBottom: 4,
      }}
    />
  );
}

/** Draws a trash can. Input: none. Output: a trash glyph in red. */
export function IconTrash() {
  return (
    <View style={{ width: 14, height: 16, alignItems: "center" }}>
      <View style={{ width: 10, height: 1.4, backgroundColor: "#FF453A" }} />
      <View style={{ width: 12, height: 12, borderRadius: 2, borderWidth: 1.4, borderColor: "#FF453A", marginTop: 1 }} />
    </View>
  );
}

/** Draws a small reply mark for a list preview. Input: none. Output: a check-shaped mark. */
export function IconReply() {
  return (
    <View style={{ width: 12, height: 10, marginRight: 6 }}>
      <View
        style={{
          width: 6,
          height: 6,
          borderLeftWidth: 1.4,
          borderBottomWidth: 1.4,
          borderColor: "#8E8E93",
          transform: [{ rotate: "-45deg" }],
          marginTop: 1,
        }}
      />
    </View>
  );
}
