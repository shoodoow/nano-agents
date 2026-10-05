import { useRef, type RefObject } from "react";
import { StyleSheet, View, type ViewProps } from "react-native";
import type { WebView } from "react-native-webview";

/**
 * Full-stage touch surface for trackpad mode. The VNC canvas is often
 * letterboxed inside the WebView; this layer keeps receiving drags anywhere
 * on the stage and forwards deltas into the noVNC shell.
 */
export function TrackpadCapture({
  webRef,
  ...rest
}: { webRef: RefObject<WebView | null> } & ViewProps) {
  const last = useRef<{ x: number; y: number } | null>(null);

  function step(phase: number, dx: number, dy: number): void {
    webRef.current?.injectJavaScript(
      `window.nanoTrackpadStep && window.nanoTrackpadStep(${phase}, ${dx}, ${dy}); true;`,
    );
  }

  return (
    <View
      {...rest}
      style={[StyleSheet.absoluteFill, rest.style]}
      collapsable={false}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e) => {
        last.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
        step(0, 0, 0);
      }}
      onResponderMove={(e) => {
        if (!last.current) {
          return;
        }
        const x = e.nativeEvent.pageX;
        const y = e.nativeEvent.pageY;
        step(1, x - last.current.x, y - last.current.y);
        last.current = { x, y };
      }}
      onResponderRelease={() => {
        step(2, 0, 0);
        last.current = null;
      }}
      onResponderTerminate={() => {
        step(2, 0, 0);
        last.current = null;
      }}
    />
  );
}
