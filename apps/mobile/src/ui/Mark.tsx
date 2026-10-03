import { useEffect, useRef, type ReactNode } from "react";
import { Animated, Easing, Pressable, StyleSheet, View } from "react-native";
import type { MarkShape } from "@nano-agents/shared";

export type { MarkShape };

export type MarkMood = "idle" | "working";

/** Picker shapes: one clean row + a single extra (triangle). Hexagon/cloud/drop still render if already saved. */
export const MARK_SHAPES: { id: MarkShape; label: string }[] = [
  { id: "circle", label: "Circle" },
  { id: "blob", label: "Blob" },
  { id: "square", label: "Rounded square" },
  { id: "pill", label: "Pill" },
  { id: "triangle", label: "Triangle" },
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
const FULL_SIZE = 64;

/**
 * Draws the bot's character mark: one of eight shapes with two slanted eyes.
 * Why: picker grid and static surfaces stay still; LivingMark adds soul.
 * Input: shape, color, pixel size. Output: the mark.
 */
export function Mark({ shape, color, size }: { shape: MarkShape; color: string; size: number }) {
  const metrics = eyeMetrics(shape, size);
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={`${shape} mark`}
      style={[styles.stage, { width: size * 1.4, height: size }]}
    >
      {body(shape, color, size)}
      <View pointerEvents="none" style={[styles.eyes, { marginTop: metrics.eyeDy }]}>
        <View style={[eyeStyle(metrics.eyeWidth, metrics.eyeHeight), { transform: [{ rotate: "24deg" }] }]} />
        <View
          style={[
            eyeStyle(metrics.eyeWidth, metrics.eyeHeight),
            { marginLeft: metrics.eyeGap, transform: [{ rotate: "24deg" }] },
          ]}
        />
      </View>
    </View>
  );
}

/**
 * Playful living mark: idle wander, work frenzy, optional tap-to-wink.
 * Why: same silhouette as Mark, but eyes/body move so the bot feels present.
 * Small sizes stay quiet (blink + tiny glance only).
 */
export function LivingMark({
  shape,
  color,
  size,
  mood = "idle",
  interactive = false,
}: {
  shape: MarkShape;
  color: string;
  size: number;
  mood?: MarkMood;
  interactive?: boolean;
}) {
  const full = size >= FULL_SIZE;
  const canTap = interactive && full;
  const metrics = eyeMetrics(shape, size);

  const glance = useRef(new Animated.Value(0)).current;
  const blink = useRef(new Animated.Value(1)).current;
  const leftOpen = useRef(new Animated.Value(1)).current;
  const rightOpen = useRef(new Animated.Value(1)).current;
  const breath = useRef(new Animated.Value(1)).current;
  const tilt = useRef(new Animated.Value(0)).current;
  const bounce = useRef(new Animated.Value(1)).current;
  const loops = useRef<Animated.CompositeAnimation[]>([]);
  const moodRef = useRef(mood);
  moodRef.current = mood;

  useEffect(() => {
    stopLoops(loops.current);
    loops.current = [];
    glance.setValue(0);
    blink.setValue(1);
    leftOpen.setValue(1);
    rightOpen.setValue(1);
    breath.setValue(1);
    tilt.setValue(0);
    bounce.setValue(1);

    const working = mood === "working";
    const glanceAmp = full ? (working ? 3.2 : 2.4) : working ? 1.6 : 1.1;
    const glanceMs = working ? 420 : full ? 2200 : 3200;
    const blinkEvery = working ? 900 : full ? 2800 : 4200;

    const glanceLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(glance, {
          toValue: glanceAmp,
          duration: glanceMs * (working ? 0.35 : 0.55),
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(glance, {
          toValue: -glanceAmp * (working ? 1.1 : 0.85),
          duration: glanceMs,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(glance, {
          toValue: working ? glanceAmp * 0.6 : 0,
          duration: glanceMs * 0.7,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.delay(working ? 80 : full ? 900 : 1400),
      ]),
    );
    loops.current.push(glanceLoop);
    glanceLoop.start();

    const blinkLoop = Animated.loop(
      Animated.sequence([
        Animated.delay(blinkEvery + Math.floor(Math.random() * 800)),
        Animated.timing(blink, { toValue: 0.08, duration: working ? 60 : 90, useNativeDriver: true }),
        Animated.timing(blink, { toValue: 1, duration: working ? 70 : 110, useNativeDriver: true }),
        // Occasional double-blink when idle and full-size.
        ...(full && !working
          ? [
              Animated.delay(70),
              Animated.timing(blink, { toValue: 0.08, duration: 70, useNativeDriver: true }),
              Animated.timing(blink, { toValue: 1, duration: 100, useNativeDriver: true }),
            ]
          : []),
      ]),
    );
    loops.current.push(blinkLoop);
    blinkLoop.start();

    if (full) {
      const breathLoop = Animated.loop(
        Animated.sequence([
          Animated.timing(breath, {
            toValue: working ? 1.045 : 1.03,
            duration: working ? 380 : 1600,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
          Animated.timing(breath, {
            toValue: 1,
            duration: working ? 420 : 1800,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
        ]),
      );
      loops.current.push(breathLoop);
      breathLoop.start();

      if (working) {
        const tiltLoop = Animated.loop(
          Animated.sequence([
            Animated.timing(tilt, {
              toValue: 1,
              duration: 280,
              easing: Easing.inOut(Easing.quad),
              useNativeDriver: true,
            }),
            Animated.timing(tilt, {
              toValue: -1,
              duration: 320,
              easing: Easing.inOut(Easing.quad),
              useNativeDriver: true,
            }),
            Animated.timing(tilt, {
              toValue: 0,
              duration: 240,
              easing: Easing.inOut(Easing.sin),
              useNativeDriver: true,
            }),
            Animated.delay(160),
          ]),
        );
        loops.current.push(tiltLoop);
        tiltLoop.start();
      }
    }

    return () => stopLoops(loops.current);
  }, [mood, full, glance, blink, breath, tilt, bounce, leftOpen, rightOpen]);

  function wink(): void {
    if (!canTap) return;
    // Pause right eye open channel for a wink, then happy bounce.
    Animated.sequence([
      Animated.timing(rightOpen, { toValue: 0.05, duration: 90, useNativeDriver: true }),
      Animated.delay(120),
      Animated.timing(rightOpen, { toValue: 1, duration: 140, useNativeDriver: true }),
      Animated.spring(bounce, { toValue: 1.1, friction: 4, tension: 160, useNativeDriver: true }),
      Animated.spring(bounce, { toValue: 1, friction: 5, tension: 140, useNativeDriver: true }),
    ]).start();
  }

  const rotate = tilt.interpolate({
    inputRange: [-1, 0, 1],
    outputRange: ["-7deg", "0deg", "7deg"],
  });
  const leftScaleY = Animated.multiply(blink, leftOpen);
  const rightScaleY = Animated.multiply(blink, rightOpen);

  const content = (
    <Animated.View
      accessibilityRole="image"
      accessibilityLabel={`${shape} mark${mood === "working" ? ", working" : ""}`}
      style={[
        styles.stage,
        {
          width: size * 1.4,
          height: size,
          transform: [{ scale: Animated.multiply(breath, bounce) }, { rotate }],
        },
      ]}
    >
      {body(shape, color, size)}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.eyes,
          {
            marginTop: metrics.eyeDy,
            transform: [{ translateX: glance }],
          },
        ]}
      >
        <Animated.View
          style={[eyeStyle(metrics.eyeWidth, metrics.eyeHeight), { transform: [{ rotate: "24deg" }, { scaleY: leftScaleY }] }]}
        />
        <Animated.View
          style={[
            eyeStyle(metrics.eyeWidth, metrics.eyeHeight),
            { marginLeft: metrics.eyeGap, transform: [{ rotate: "24deg" }, { scaleY: rightScaleY }] },
          ]}
        />
      </Animated.View>
    </Animated.View>
  );

  if (!canTap) return content;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Wink" onPress={wink}>
      {content}
    </Pressable>
  );
}

function stopLoops(items: Animated.CompositeAnimation[]): void {
  for (const item of items) item.stop();
}

function eyeMetrics(shape: MarkShape, size: number) {
  return {
    eyeWidth: Math.max(3, size * 0.075),
    eyeHeight: size * 0.21,
    eyeGap: size * 0.13,
    eyeDy: shape === "triangle" ? size * 0.16 : shape === "drop" ? size * 0.06 : 0,
  };
}

function eyeStyle(width: number, height: number) {
  return {
    width,
    height,
    borderRadius: width / 2,
    backgroundColor: INK,
  };
}

/** Draws the shape silhouette. Input: shape, color, size. Output: the body views. */
function body(shape: MarkShape, color: string, size: number): ReactNode {
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
