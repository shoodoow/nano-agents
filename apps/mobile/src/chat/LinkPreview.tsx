import { useEffect, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { IconGlobe } from "../ui/icons";
import { hostOf, originOf, parseLinkMeta, type LinkMeta } from "./link-meta";

// One page fetch per link for the life of the process, shared by every bubble
// that shows it. `resolved` lets a re-mounted row paint the card with no flash.
const pending = new Map<string, Promise<LinkMeta>>();
const resolved = new Map<string, LinkMeta>();

// Links to files have no page title, and fetching one would download the file.
const NOT_A_PAGE =
  /\.(pdf|zip|gz|tgz|rar|7z|dmg|exe|apk|ipa|mp4|mov|m4v|webm|mkv|mp3|wav|m4a|png|jpe?g|gif|webp|svg|heic|csv|xlsx?|docx?|pptx?|json|xml|txt)([?#]|$)/i;

function loadLinkMeta(url: string): Promise<LinkMeta> {
  const known = pending.get(url);
  if (known) return known;
  const fallback: LinkMeta = { title: null, site: null, icon: `${originOf(url)}/favicon.ico` };
  const request = (async (): Promise<LinkMeta> => {
    if (NOT_A_PAGE.test(url)) return fallback;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      // The title lives in the head, so ask for the first part of the page only.
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "text/html", Range: "bytes=0-131071" },
      });
      const type = response.headers.get("content-type") ?? "";
      if (!response.ok || !type.includes("html")) return fallback;
      return parseLinkMeta(await response.text(), url);
    } catch {
      return fallback;
    } finally {
      clearTimeout(timer);
    }
  })().then((meta) => {
    resolved.set(url, meta);
    return meta;
  });
  pending.set(url, request);
  return request;
}

/**
 * Shows one link as a card: favicon, page title, and host.
 * Why: a raw URL says nothing about where it goes. The host shows at once and
 * the title replaces it when the page answers; a failed fetch keeps the host.
 * Input: the link. Output: a tappable card that opens it.
 */
export function LinkPreview({ url }: { url: string }) {
  const [meta, setMeta] = useState<LinkMeta | null>(resolved.get(url) ?? null);
  const [iconFailed, setIconFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void loadLinkMeta(url).then((next) => {
      if (live) setMeta(next);
    });
    return () => {
      live = false;
    };
  }, [url]);
  const host = hostOf(url);
  const title = meta?.title ?? host;
  const detail = meta?.title ? (meta.site && meta.site.toLowerCase() !== host ? `${meta.site} · ${host}` : host) : url;
  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed ? styles.pressed : null]}
      onPress={() => void Linking.openURL(url)}
      accessibilityRole="link"
      accessibilityLabel={`${title}, ${host}`}
    >
      {meta?.icon && !iconFailed ? (
        <Image source={{ uri: meta.icon }} style={styles.icon} contentFit="contain" onError={() => setIconFailed(true)} />
      ) : (
        <View style={[styles.icon, styles.iconFallback]}>
          <IconGlobe />
        </View>
      )}
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={2}>
          {title}
        </Text>
        <Text style={styles.host} numberOfLines={1}>
          {detail}
        </Text>
      </View>
    </Pressable>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
    card: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      backgroundColor: colors.control,
      borderRadius: 12,
      borderCurve: "continuous",
      paddingVertical: 8,
      paddingHorizontal: 10,
      minWidth: 200,
    },
    pressed: { opacity: 0.6 },
    icon: { width: 28, height: 28, borderRadius: 7 },
    iconFallback: { alignItems: "center", justifyContent: "center", backgroundColor: colors.line },
    text: { flex: 1, gap: 1 },
    title: { color: colors.text, fontSize: 14, fontWeight: "600", lineHeight: 18 },
    host: { color: colors.muted, fontSize: 12 },
  });
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
