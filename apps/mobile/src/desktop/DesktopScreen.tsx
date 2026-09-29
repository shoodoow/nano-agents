import { useEffect, useRef, useState } from "react";
import { Alert, Image, Platform, StyleSheet, Text, TextInput, View, type GestureResponderEvent } from "react-native";
import { createCore } from "../api";
import type { RosterAgent } from "../api";
import { authClient } from "../auth";
import { colors } from "../theme/tokens";
import { Avatar } from "../ui/Avatar";
import { CircleButton } from "../ui/CircleButton";
import { IconBack, IconClipboard, IconHelp, IconKeyboard, IconMore } from "../ui/icons";
import { mapPointer, RfbReader, type ViewSize } from "./rfb";

const core = createCore();

/**
 * Shows one agent's desktop with the Grok remote-screen chrome.
 * Input: the account id, the agent, and navigation plus error handlers.
 * Output: the live screen, take-over, and hand-back controls.
 */
export function DesktopScreen({
  accountId,
  agent,
  onBack,
  onProfile,
  onApprovals,
  onError,
}: {
  accountId: string;
  agent: RosterAgent;
  onBack: () => void;
  onProfile: () => void;
  onApprovals: () => void;
  onError: (error: unknown) => void;
}) {
  const profile = agent.linuxProfile ?? "";
  const [frames, setFrames] = useState(0);
  const [open, setOpen] = useState(false);
  const [picture, setPicture] = useState<string | null>(null);
  const [taken, setTaken] = useState(false);
  const [typed, setTyped] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const readerRef = useRef(new RfbReader());
  const viewRef = useRef<ViewSize>({ width: 0, height: 0 });
  const waitRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!profile) {
      return;
    }
    const reader = new RfbReader();
    readerRef.current = reader;
    const url = core.screenUrl(accountId, profile);
    const NativeWebSocket = WebSocket as unknown as new (
      url: string,
      protocols?: string[] | null,
      options?: { headers?: Record<string, string> },
    ) => WebSocket;
    const socket =
      Platform.OS === "web"
        ? new WebSocket(url)
        : new NativeWebSocket(url, null, { headers: { cookie: authClient.getCookie() } });
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;
    const publish = (events: ReturnType<RfbReader["push"]>) => {
      for (const item of events) {
        if (item.type === "send") {
          socket.send(item.data.slice().buffer);
        } else if (item.type === "frame") {
          setPicture(item.uri);
          setFrames((count) => count + 1);
        } else {
          onError(new Error(item.message));
        }
      }
    };
    socket.onopen = () => setOpen(true);
    socket.onmessage = (event) => {
      const bytes = messageBytes(event.data);
      if (!bytes) {
        return;
      }
      publish(reader.push(bytes));
      const delay = reader.dueIn(Date.now());
      if (delay === null) {
        return;
      }
      if (waitRef.current) {
        clearTimeout(waitRef.current);
      }
      waitRef.current = setTimeout(() => {
        publish(reader.pump(Date.now()));
      }, delay);
    };
    socket.onerror = () => onError(new Error("The screen socket failed."));
    return () => {
      if (waitRef.current) {
        clearTimeout(waitRef.current);
      }
      socketRef.current = null;
      socket.close();
    };
  }, [accountId, profile, onError]);

  function sendPointer(event: GestureResponderEvent, buttons: number): void {
    const frame = readerRef.current.size;
    const socket = socketRef.current;
    if (!frame || !socket) {
      return;
    }
    if (!taken) {
      setTaken(true);
      void core.takeOver(accountId, profile).catch(onError);
    }
    const point = mapPointer(event.nativeEvent.locationX, event.nativeEvent.locationY, viewRef.current, frame);
    if (!point) {
      return;
    }
    socket.send(readerRef.current.pointer(point.x, point.y, buttons).slice().buffer);
  }

  function sendKey(keysym: number): void {
    const socket = socketRef.current;
    if (!taken || !socket) {
      return;
    }
    socket.send(readerRef.current.key(keysym, true).slice().buffer);
    socket.send(readerRef.current.key(keysym, false).slice().buffer);
  }

  function typeText(next: string): void {
    if (next.length < typed.length) {
      sendKey(0xff08);
    } else {
      for (const char of next.slice(typed.length)) {
        sendKey(char === "\n" ? 0xff0d : char.charCodeAt(0));
      }
    }
    setTyped(next);
  }

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.headerSide}>
          <CircleButton label="Back" onPress={onBack}>
            <IconBack />
          </CircleButton>
          <Avatar id={agent.id} size={22} round />
          <Text style={styles.name}>{agent.name}</Text>
        </View>
        <View style={styles.headerSide}>
          <CircleButton
            label="About this screen"
            onPress={() =>
              Alert.alert("Desktop", "You are watching this agent's screen. Take the keyboard to use the pointer, then hand it back.")
            }
          >
            <IconHelp />
          </CircleButton>
          <CircleButton
            label="More"
            onPress={() =>
              Alert.alert(agent.name, undefined, [
                { text: "Edit profile", onPress: onProfile },
                { text: "Approvals", onPress: onApprovals },
                { text: "Cancel", style: "cancel" },
              ])
            }
          >
            <IconMore />
          </CircleButton>
        </View>
      </View>
      <View
        style={styles.stage}
        onLayout={(event) => {
          viewRef.current = { width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height };
        }}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={(event) => sendPointer(event, 1)}
        onResponderMove={(event) => sendPointer(event, 1)}
        onResponderRelease={(event) => sendPointer(event, 0)}
      >
        {picture ? <Image source={{ uri: picture }} style={styles.picture} resizeMode="contain" /> : null}
        <Text style={styles.status} pointerEvents="none">{open ? `Live · ${frames} frames` : "Connecting"}</Text>
      </View>
      {taken ? (
        <TextInput
          autoFocus
          value={typed}
          onChangeText={typeText}
          placeholder="Type to the computer"
          placeholderTextColor="#888"
          returnKeyType="send"
          onSubmitEditing={() => sendKey(0xff0d)}
          style={styles.keys}
        />
      ) : null}
      <View style={styles.footer}>
        <CircleButton
          label="Hand back"
          onPress={() => {
            setTaken(false);
            void core.handBack(accountId, profile).catch(onError);
          }}
        >
          <IconClipboard />
        </CircleButton>
        <CircleButton
          label="Take over"
          onPress={() => {
            void core.takeOver(accountId, profile).then(() => setTaken(true)).catch(onError);
          }}
        >
          <IconKeyboard />
        </CircleButton>
      </View>
    </View>
  );
}

function messageBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 8, paddingVertical: 4 },
  headerSide: { flexDirection: "row", alignItems: "center", gap: 6 },
  name: { color: colors.text, fontSize: 17, fontWeight: "600" },
  stage: { flex: 1, backgroundColor: "#111", alignItems: "center", justifyContent: "flex-end", paddingBottom: 16 },
  picture: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
  status: { color: "#ddd", fontSize: 13 },
  keys: { marginHorizontal: 16, marginBottom: 8, color: colors.text, backgroundColor: "#1c1c1c", borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10 },
  footer: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 18 },
});
