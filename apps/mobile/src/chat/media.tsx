import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { Image } from "expo-image";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { VideoView, useVideoPlayer } from "expo-video";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MessageBlock } from "../api";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { IconCloseLight, IconPlay } from "../ui/icons";

export type FetchBlob = (messageId: string, index: number) => Promise<{ url?: string; previewUrl?: string }>;
export type ImageBlock = Extract<MessageBlock, { kind: "image" }>;
export type FileBlock = Extract<MessageBlock, { kind: "file" }>;

// Client-side bytes cache: one fetch per attachment no matter how often the
// thread re-renders or refreshes. Keyed messageId:index, process-lifetime.
const blobCache = new Map<string, { url?: string; previewUrl?: string }>();

/**
 * Resolves the picture for one image block, fetching stripped bytes on demand.
 * Why: lists carry a blobRef instead of the bytes, so the thread stays at
 * kilobytes. `full` asks for the original (the viewer); bubbles take the
 * small preview when there is one.
 * Input: block, fetcher, full flag. Output: a URI, or null while it loads.
 */
function useImageUri(block: ImageBlock, fetchBlob: FetchBlob | undefined, full = false): string | null {
  const inline = full ? block.url || block.previewUrl : block.previewUrl || block.url;
  const cacheKey = block.blobRef ? `${block.blobRef.messageId}:${block.blobRef.index}` : null;
  const [blob, setBlob] = useState(cacheKey ? (blobCache.get(cacheKey) ?? null) : null);
  const messageId = block.blobRef?.messageId;
  const index = block.blobRef?.index;
  useEffect(() => {
    if (inline || !cacheKey || !fetchBlob || messageId === undefined || index === undefined) return;
    const cached = blobCache.get(cacheKey);
    if (cached) {
      setBlob(cached);
      return;
    }
    let live = true;
    void fetchBlob(messageId, index)
      .then((next) => {
        blobCache.set(cacheKey, next);
        if (live) setBlob(next);
      })
      .catch(() => {
        // Offline or gone: placeholder stays, refresh retries via remount.
      });
    return () => {
      live = false;
    };
  }, [inline, cacheKey, messageId, index, fetchBlob]);
  if (inline) return inline;
  if (!blob) return null;
  return (full ? blob.url || blob.previewUrl : blob.previewUrl || blob.url) ?? null;
}

const ALBUM_WIDTH = 240;
const ALBUM_GAP = 2;
const ALBUM_MAX_TILES = 4;

type Tile = { left: number; top: number; width: number; height: number };

/**
 * Lays several pictures out as one mosaic, Telegram-album style.
 * Input: how many pictures. Output: the album height and one box per tile
 * (at most four; the caller draws "+N" on the last when there are more).
 */
export function albumLayout(count: number): { height: number; tiles: Tile[] } {
  const half = (ALBUM_WIDTH - ALBUM_GAP) / 2;
  if (count === 2) {
    return {
      height: 160,
      tiles: [
        { left: 0, top: 0, width: half, height: 160 },
        { left: half + ALBUM_GAP, top: 0, width: half, height: 160 },
      ],
    };
  }
  if (count === 3) {
    const wide = 158;
    const narrow = ALBUM_WIDTH - wide - ALBUM_GAP;
    const small = (200 - ALBUM_GAP) / 2;
    return {
      height: 200,
      tiles: [
        { left: 0, top: 0, width: wide, height: 200 },
        { left: wide + ALBUM_GAP, top: 0, width: narrow, height: small },
        { left: wide + ALBUM_GAP, top: small + ALBUM_GAP, width: narrow, height: small },
      ],
    };
  }
  return {
    height: ALBUM_WIDTH,
    tiles: [0, 1, 2, 3].map((slot) => ({
      left: (slot % 2) * (half + ALBUM_GAP),
      top: Math.floor(slot / 2) * (half + ALBUM_GAP),
      width: half,
      height: half,
    })),
  };
}

function ImageTile({
  block,
  fetchBlob,
  more,
  onPress,
}: {
  block: ImageBlock;
  fetchBlob?: FetchBlob;
  /** Pictures hidden behind this tile, drawn as "+N". */
  more?: number;
  onPress: () => void;
}) {
  const uri = useImageUri(block, fetchBlob);
  return (
    <Pressable
      style={styles.fill}
      onPress={onPress}
      accessibilityRole="imagebutton"
      accessibilityLabel={block.alt ?? "Shared image"}
    >
      {uri ? <Image source={{ uri }} style={styles.fill} contentFit="cover" transition={120} /> : <View style={styles.loading} />}
      {more ? (
        <View style={styles.moreVeil}>
          <Text style={styles.moreText}>+{more}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/**
 * Renders the pictures of one message: a single photo, or an album mosaic.
 * Why: several screenshots in a row used to stack as full-size photos and push
 * the thread away. Tapping any picture opens the full-screen viewer.
 * Input: the image blocks that sit together + blob fetcher. Output: the view.
 */
export function ImageGroup({ images, fetchBlob }: { images: ImageBlock[]; fetchBlob?: FetchBlob }) {
  const [viewing, setViewing] = useState<number | null>(null);
  const viewer =
    viewing !== null ? (
      <ImageViewer images={images} start={viewing} fetchBlob={fetchBlob} onClose={() => setViewing(null)} />
    ) : null;
  const first = images[0];
  if (!first) return null;
  if (images.length === 1) {
    return (
      <View style={styles.mediaWrap}>
        <View style={styles.single}>
          <ImageTile block={first} fetchBlob={fetchBlob} onPress={() => setViewing(0)} />
        </View>
        {first.alt ? <Text style={styles.caption}>{first.alt}</Text> : null}
        {viewer}
      </View>
    );
  }
  const { height, tiles } = albumLayout(images.length);
  const hidden = images.length - ALBUM_MAX_TILES;
  return (
    <View style={[styles.album, { height }]}>
      {tiles.map((tile, slot) => {
        const block = images[slot];
        if (!block) return null;
        return (
          <View key={slot} style={[styles.tile, tile]}>
            <ImageTile
              block={block}
              fetchBlob={fetchBlob}
              more={slot === ALBUM_MAX_TILES - 1 && hidden > 0 ? hidden : undefined}
              onPress={() => setViewing(slot)}
            />
          </View>
        );
      })}
      {viewer}
    </View>
  );
}

function ViewerPage({
  block,
  fetchBlob,
  width,
  height,
}: {
  block: ImageBlock;
  fetchBlob?: FetchBlob;
  width: number;
  height: number;
}) {
  const uri = useImageUri(block, fetchBlob, true);
  return (
    // A zooming ScrollView per page gives native pinch and double-tap-drag.
    <ScrollView
      style={{ width, height }}
      contentContainerStyle={{ width, height }}
      maximumZoomScale={4}
      minimumZoomScale={1}
      centerContent
      bouncesZoom
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}
    >
      {uri ? (
        <Image source={{ uri }} style={{ width, height }} contentFit="contain" accessibilityLabel={block.alt ?? "Shared image"} />
      ) : (
        <View style={[styles.viewerLoading, { width, height }]}>
          <ActivityIndicator color="#FFFFFF" />
        </View>
      )}
    </ScrollView>
  );
}

/** Full-screen pager over one message's pictures: swipe between, pinch to zoom. */
function ImageViewer({
  images,
  start,
  fetchBlob,
  onClose,
}: {
  images: ImageBlock[];
  start: number;
  fetchBlob?: FetchBlob;
  onClose: () => void;
}) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [index, setIndex] = useState(start);
  const caption = images[index]?.alt;
  return (
    <Modal visible animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.viewer}>
        <FlatList
          data={images}
          horizontal
          pagingEnabled
          initialScrollIndex={start}
          getItemLayout={(_data, item) => ({ length: width, offset: width * item, index: item })}
          keyExtractor={(_block, item) => String(item)}
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={(event) => setIndex(Math.round(event.nativeEvent.contentOffset.x / width))}
          renderItem={({ item }) => <ViewerPage block={item} fetchBlob={fetchBlob} width={width} height={height} />}
        />
        <View style={[styles.viewerBar, { top: insets.top + 8 }]} pointerEvents="box-none">
          <Pressable style={styles.viewerButton} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close">
            <IconCloseLight />
          </Pressable>
          {images.length > 1 ? (
            <Text style={styles.viewerCount}>
              {index + 1} / {images.length}
            </Text>
          ) : null}
          <View style={styles.viewerSpacer} />
        </View>
        {caption ? (
          <Text style={[styles.viewerCaption, { bottom: insets.bottom + 16 }]} numberOfLines={3}>
            {caption}
          </Text>
        ) : null}
      </View>
    </Modal>
  );
}

const VIDEO_NAME = /\.(mp4|m4v|mov)([?#]|$)/i;
const VIDEO_MIME: Record<string, string> = { "video/mp4": ".mp4", "video/quicktime": ".mov", "video/x-m4v": ".m4v" };

/** True for file blocks the system player can play in place. */
export function isVideoBlock(block: FileBlock): boolean {
  if ((block.mime ?? "").toLowerCase() in VIDEO_MIME) return true;
  return VIDEO_NAME.test(block.name) || (/^https?:\/\//i.test(block.url) && VIDEO_NAME.test(block.url));
}

/**
 * Turns a file block into something the device can open: a web URL as it is,
 * or inline/lazy bytes written to the cache folder.
 * Input: block, fetcher, and `keep` to give the file its own name and reuse it
 * (playback); without it the plain name is rewritten each time (share sheet).
 * Output: a URL or file URI plus the mime type found, or null with no bytes.
 */
async function materializeFile(
  block: FileBlock,
  fetchBlob: FetchBlob | undefined,
  keep = false,
): Promise<{ uri: string; mime?: string; local: boolean } | null> {
  let url = block.url;
  if (!url && block.blobRef && fetchBlob) {
    url = (await fetchBlob(block.blobRef.messageId, block.blobRef.index)).url ?? "";
  }
  if (!url) return null;
  const data = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(url);
  if (!data) return { uri: url, mime: block.mime, local: false };
  const mime = block.mime ?? data[1];
  let name = block.name.replace(/[^A-Za-z0-9._-]+/g, "_") || "attachment";
  // The player picks its decoder from the extension, so a bare name gets one.
  const extension = VIDEO_MIME[(mime ?? "").toLowerCase()];
  if (keep && extension && !VIDEO_NAME.test(name)) name = `${name}${extension}`;
  if (keep && block.blobRef) name = `${block.blobRef.messageId.slice(0, 8)}-${block.blobRef.index}-${name}`;
  const file = new File(Paths.cache, name);
  if (keep && file.exists) return { uri: file.uri, mime, local: true };
  const raw = globalThis.atob(data[2]!);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  if (file.exists) file.delete();
  file.create();
  file.write(bytes);
  return { uri: file.uri, mime, local: true };
}

/** Resolves lazy bytes, writes them to device cache, then opens the native share/preview sheet. */
export async function openFileBlock(block: FileBlock, fetchBlob?: FetchBlob): Promise<void> {
  const file = await materializeFile(block, fetchBlob);
  if (!file) return;
  if (file.local && (await Sharing.isAvailableAsync())) {
    await Sharing.shareAsync(file.uri, { mimeType: file.mime, dialogTitle: `Open ${block.name}` });
  } else {
    await Linking.openURL(file.uri);
  }
}

function InlineVideo({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (created) => {
    created.play();
  });
  return (
    <VideoView
      player={player}
      style={styles.video}
      nativeControls
      contentFit="contain"
      fullscreenOptions={{ enable: true }}
      allowsPictureInPicture={false}
    />
  );
}

/**
 * Plays a video the agent sent, in the bubble, with the system player.
 * Why: a video used to be a "Tap to open" file row that left the chat. The
 * poster costs nothing; the bytes load and the player starts on the first tap,
 * so a thread full of videos does not hold a decoder each.
 * Input: a video file block + blob fetcher. Output: poster, then the player.
 */
export function VideoBlock({ block, fetchBlob }: { block: FileBlock; fetchBlob?: FetchBlob }) {
  const [uri, setUri] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  function start(): void {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    void materializeFile(block, fetchBlob, true)
      .then((file) => {
        if (file) setUri(file.uri);
        else setFailed(true);
      })
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  }

  return (
    <View style={styles.mediaWrap}>
      {uri ? (
        <InlineVideo uri={uri} />
      ) : (
        <Pressable style={styles.poster} onPress={start} accessibilityRole="button" accessibilityLabel={`Play ${block.name}`}>
          <View style={styles.playDisk}>{busy ? <ActivityIndicator color="#FFFFFF" /> : <IconPlay />}</View>
        </Pressable>
      )}
      <Text style={styles.caption} numberOfLines={1}>
        {failed ? "Could not load this video. Tap to retry." : block.name}
      </Text>
    </View>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
    mediaWrap: { gap: 6 },
    fill: { flex: 1 },
    single: { width: ALBUM_WIDTH, height: 180, borderRadius: 12, overflow: "hidden", backgroundColor: colors.control },
    loading: { flex: 1, backgroundColor: colors.control, opacity: 0.6 },
    caption: { color: colors.muted, fontSize: 13, maxWidth: ALBUM_WIDTH },
    album: { width: ALBUM_WIDTH, borderRadius: 12, borderCurve: "continuous", overflow: "hidden" },
    tile: { position: "absolute", backgroundColor: colors.control },
    moreVeil: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: "rgba(0,0,0,0.5)",
      alignItems: "center",
      justifyContent: "center",
    },
    moreText: { color: "#FFFFFF", fontSize: 22, fontWeight: "600" },
    viewer: { flex: 1, backgroundColor: "#000000" },
    viewerLoading: { alignItems: "center", justifyContent: "center" },
    viewerBar: {
      position: "absolute",
      left: 12,
      right: 12,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    viewerButton: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: "rgba(60,60,60,0.7)",
      alignItems: "center",
      justifyContent: "center",
    },
    viewerSpacer: { width: 36 },
    viewerCount: { color: "#FFFFFF", fontSize: 15, fontWeight: "600", fontVariant: ["tabular-nums"] },
    viewerCaption: {
      position: "absolute",
      left: 20,
      right: 20,
      color: "#FFFFFF",
      fontSize: 14,
      textAlign: "center",
    },
    video: { width: ALBUM_WIDTH, height: 150, borderRadius: 12, overflow: "hidden", backgroundColor: "#000000" },
    poster: {
      width: ALBUM_WIDTH,
      height: 150,
      borderRadius: 12,
      backgroundColor: "#000000",
      alignItems: "center",
      justifyContent: "center",
    },
    playDisk: {
      width: 52,
      height: 52,
      borderRadius: 26,
      backgroundColor: "rgba(60,60,60,0.8)",
      alignItems: "center",
      justifyContent: "center",
    },
  });
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
